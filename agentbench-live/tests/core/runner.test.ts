import { expect, test } from "vitest";
import { estimateResources } from "@/core/runner/budget";
import { QueueCancelledError, RunQueue } from "@/core/runner/queue";
import { computeScore } from "@/core/runner/scoring";
import { transition } from "@/core/runner/state-machine";

test("rejects lifecycle jumps", () => {
  expect(() => transition("queued", "verifying")).toThrow(
    /invalid transition/i,
  );
});

test("allows the next lifecycle stage", () => {
  expect(transition("planning", "generating")).toBe("generating");
});

test("does not award dependent points after execution failure", () => {
  expect(
    computeScore({
      core: 45,
      reproducible: false,
      methodology: 15,
      evidence: 15,
      withinBudget: true,
    }),
  ).toEqual({
    core: 0,
    reproducible: 0,
    methodology: 0,
    evidence: 0,
    budget: 0,
    total: 0,
  });
});

test("caps a successful score at the published category weights", () => {
  expect(
    computeScore({
      core: 80,
      reproducible: true,
      methodology: 20,
      evidence: 30,
      withinBudget: true,
    }),
  ).toEqual({
    core: 45,
    reproducible: 20,
    methodology: 15,
    evidence: 15,
    budget: 5,
    total: 100,
  });
});

test("sums the maximum resource time for matrix confirmation", () => {
  expect(
    estimateResources([
      {
        budget: {
          totalMs: 300_000,
          browserMs: 60_000,
          sandboxMs: 180_000,
          desktopMs: 60_000,
        },
      },
      {
        budget: {
          totalMs: 120_000,
          browserMs: 0,
          sandboxMs: 120_000,
          desktopMs: 0,
        },
      },
    ]),
  ).toEqual({
    jobs: 2,
    totalMs: 420_000,
    browserMs: 60_000,
    sandboxMs: 300_000,
    desktopMs: 60_000,
  });
});

test("never executes more than two jobs", async () => {
  const queue = new RunQueue(2);
  let active = 0;
  let peak = 0;
  const job = () =>
    queue.enqueue(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    });
  await Promise.all([job(), job(), job(), job()]);
  expect(peak).toBe(2);
});

test("rejects concurrency outside Starter-safe bounds", () => {
  expect(() => new RunQueue(0)).toThrow(/concurrency/i);
  expect(() => new RunQueue(3)).toThrow(/concurrency/i);
});

test("cancels jobs that have not started", async () => {
  const queue = new RunQueue(1);
  let releaseFirst!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const first = queue.enqueue(() => {
    markStarted();
    return new Promise<void>((resolve) => (releaseFirst = resolve));
  });
  await started;
  const pending = queue.enqueue(async () => "never runs");
  const rejection = pending.catch((error: unknown) => error);

  expect(queue.cancelPending()).toBe(1);
  expect(await rejection).toBeInstanceOf(QueueCancelledError);
  releaseFirst();

  await first;
});
