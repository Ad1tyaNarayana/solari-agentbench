import { expect, test } from "vitest";
import { RunPlanSchema, validatePlanForTask } from "@/core/domain/plan";
import type { TaskManifest } from "@/core/domain/task";
import { getTask, listTasks } from "@/core/tasks/registry";
import { sameStatsTask } from "@/core/tasks/same-stats";

const task: TaskManifest = {
  id: "sample",
  version: "1.0.0",
  title: "Sample",
  prompt: "Build the sample.",
  allowedPrimitives: ["sandbox", "browser"],
  requiredEvidence: ["sandbox"],
  budget: {
    totalMs: 60_000,
    browserMs: 0,
    sandboxMs: 60_000,
    desktopMs: 0,
  },
  verifier: "sample",
};

test("rejects duplicate primitives", () => {
  expect(
    RunPlanSchema.safeParse({
      primitives: ["sandbox", "sandbox"],
      reason: { sandbox: "build" },
      verificationStrategy: "run tests",
    }).success,
  ).toBe(false);
});

test("accepts an explicit no-resource plan for evaluator-only tasks", () => {
  expect(
    RunPlanSchema.safeParse({
      primitives: [],
      reason: {},
      verificationStrategy: "deterministic evaluator",
    }).success,
  ).toBe(true);
});

test("rejects a selected primitive without a rationale", () => {
  expect(
    RunPlanSchema.safeParse({
      primitives: ["sandbox"],
      reason: {},
      verificationStrategy: "run tests",
    }).success,
  ).toBe(false);
});

test("fails closed when a plan requests a forbidden primitive", () => {
  expect(() =>
    validatePlanForTask(
      {
        primitives: ["desktop"],
        reason: { desktop: "inspect" },
        verificationStrategy: "screenshot",
      },
      task,
    ),
  ).toThrow(/desktop is not allowed/);
});

test("the registry exposes only the two versioned MVP tasks", () => {
  expect(listTasks().map((registered) => registered.id)).toEqual([
    "url-shortener",
    "same-stats-different-graph",
  ]);
  expect(() => getTask("unknown")).toThrow(/unknown task/i);
});

test("paper replication reserves time for generation and independent verification", () => {
  expect(sameStatsTask.budget).toEqual({
    totalMs: 300_000,
    browserMs: 60_000,
    sandboxMs: 180_000,
    desktopMs: 0,
  });
});

test("paper replication declares exact submission paths", () => {
  expect(sameStatsTask.prompt).toContain("submission/source/reproduce.py");
  expect(sameStatsTask.prompt).toContain("submission/source/requirements.txt");
  expect(sameStatsTask.prompt).toContain("submission/results.json");
  expect(sameStatsTask.prompt).toContain("submission/methodology.md");
  expect(sameStatsTask.prompt).toContain("submission/provenance.json");
});

test("paper replication discloses the methodology headings used by its verifier", () => {
  expect(sameStatsTask.prompt).toContain("# Seed");
  expect(sameStatsTask.prompt).toContain("# Objective Function");
  expect(sameStatsTask.prompt).toContain("# Temperature Schedule");
  expect(sameStatsTask.prompt).toContain("# Acceptance Rule");
});
