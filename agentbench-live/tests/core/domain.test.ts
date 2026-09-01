import { expect, test } from "vitest";
import { RunPlanSchema, validatePlanForTask } from "@/core/domain/plan";
import type { TaskManifest } from "@/core/domain/task";
import { getTask, listTasks } from "@/core/tasks/registry";

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

test("the empty registry fails closed for unknown tasks", () => {
  expect(listTasks()).toEqual([]);
  expect(() => getTask("unknown")).toThrow(/unknown task/i);
});
