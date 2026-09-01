import { expect, test } from "vitest";
import type { RunPlan } from "@/core/domain/plan";
import type { AgentConfig } from "@/core/domain/run";
import type { TaskManifest } from "@/core/domain/task";
import { RunEventBus } from "@/core/events/run-events";
import { SqliteRunRepository } from "@/core/persistence/sqlite-repository";
import type { DisposableWorkspace } from "@/core/security/workspace";
import type {
  GeneratorPort,
  PlannerPort,
  VerifierRegistryPort,
} from "@/core/runner/contracts";
import { AgentBenchOrchestrator } from "@/core/runner/orchestrator";

const task: TaskManifest = {
  id: "url-shortener",
  version: "1.0.0",
  title: "URL Shortener",
  prompt: "Build a URL shortener.",
  allowedPrimitives: ["sandbox", "browser", "desktop"],
  requiredEvidence: ["sandbox", "browser", "desktop"],
  budget: {
    totalMs: 300_000,
    browserMs: 60_000,
    sandboxMs: 180_000,
    desktopMs: 60_000,
  },
  verifier: "url-shortener",
};

const agent: AgentConfig = {
  id: "sol-low",
  label: "Sol · Low",
  model: "gpt-5.6-sol",
  reasoningEffort: "low",
};

const plan: RunPlan = {
  primitives: ["sandbox", "browser"],
  reason: { sandbox: "build app", browser: "inspect behavior" },
  verificationStrategy: "build and navigate",
};

function createHarness(options: {
  generatorError?: Error;
  disposeError?: Error;
} = {}) {
  const repository = new SqliteRunRepository(":memory:");
  const events = new RunEventBus();
  const planner: PlannerPort & { calls: unknown[] } = {
    calls: [],
    async plan(input) {
      this.calls.push(input);
      return plan;
    },
  };
  const generator: GeneratorPort & { calls: unknown[] } = {
    calls: [],
    async generate(input) {
      this.calls.push(input);
      if (options.generatorError) throw options.generatorError;
      return { stdout: "generated", stderr: "", events: [] };
    },
  };
  const verifier: VerifierRegistryPort & { calls: unknown[] } = {
    calls: [],
    async verify(input) {
      this.calls.push(input);
      return {
        score: {
          core: 45,
          reproducible: 20,
          methodology: 15,
          evidence: 15,
          budget: 5,
          total: 100,
        },
        evidence: { sandbox: "verified" },
        logs: ["verification passed"],
      };
    },
  };
  const workspace: DisposableWorkspace & { disposed: boolean } = {
    root: "C:\\temp\\agentbench-test",
    disposed: false,
    async dispose() {
      this.disposed = true;
      if (options.disposeError) throw options.disposeError;
    },
  };
  let workspaceCalls = 0;
  const orchestrator = new AgentBenchOrchestrator({
    repository,
    events,
    planner,
    generator,
    verifier,
    getTask: () => task,
    getAgent: () => agent,
    createWorkspace: async () => {
      workspaceCalls += 1;
      return workspace;
    },
    packageSubmission: async () => ({
      entries: { "results.json": "{}" },
      digest: "digest",
    }),
    schemaPath: "C:\\schemas\\run-plan.schema.json",
    solariApiKey: "test-key",
  });
  return {
    repository,
    events,
    planner,
    generator,
    verifier,
    workspace,
    orchestrator,
    get workspaceCalls() {
      return workspaceCalls;
    },
  };
}

test("dry-run validates a plan without creating or invoking later stages", async () => {
  const harness = createHarness();
  const report = await harness.orchestrator.dryRun({
    taskId: "url-shortener",
    agentId: "sol-low",
  });
  expect(report.plan.primitives).toContain("sandbox");
  expect(report.estimatedMaximumMinutes).toBe(5);
  expect(harness.workspaceCalls).toBe(0);
  expect(harness.generator.calls).toHaveLength(0);
  expect(harness.verifier.calls).toHaveLength(0);
  harness.repository.close();
});

test("persists generation failure and disposes the workspace", async () => {
  const harness = createHarness({ generatorError: new Error("boom") });
  const run = await harness.orchestrator.run({
    taskId: "url-shortener",
    agentId: "sol-low",
  });
  expect(run).toMatchObject({
    stage: "failed",
    failureCode: "agent_failed",
    lastSuccessfulStage: "planning",
  });
  expect(harness.workspace.disposed).toBe(true);
  harness.repository.close();
});

test("persists the complete successful lifecycle and score", async () => {
  const harness = createHarness();
  const seen: string[] = [];
  const originalPublish = harness.events.publish.bind(harness.events);
  harness.events.publish = (runId, event) => {
    seen.push(String(event.payload.stage));
    originalPublish(runId, event);
  };
  const run = await harness.orchestrator.run({
    taskId: "url-shortener",
    agentId: "sol-low",
  });
  expect(run).toMatchObject({ stage: "completed", score: { total: 100 } });
  expect(seen).toEqual([
    "planning",
    "generating",
    "provisioning",
    "building",
    "verifying",
    "capturing",
    "completed",
  ]);
  harness.repository.close();
});

test("creates a durable queued run before executing that same record", async () => {
  const harness = createHarness();
  const request = { taskId: "url-shortener", agentId: "sol-low" };

  const queued = harness.orchestrator.create(request);
  expect(queued).toMatchObject({
    taskId: request.taskId,
    agentId: request.agentId,
    stage: "queued",
  });

  const completed = await harness.orchestrator.runCreated(queued.id, request);
  expect(completed).toMatchObject({ id: queued.id, stage: "completed" });
  expect(harness.repository.list()).toHaveLength(1);
  harness.repository.close();
});

test("records cleanup failure without overwriting a completed result", async () => {
  const harness = createHarness({ disposeError: new Error("locked") });
  const run = await harness.orchestrator.run({
    taskId: "url-shortener",
    agentId: "sol-low",
  });
  expect(run.stage).toBe("completed");
  expect(run.failureCode).toBeUndefined();
  expect(run.cleanupIssues).toEqual([
    { code: "cleanup_failed", detail: "locked" },
  ]);
  harness.repository.close();
});
