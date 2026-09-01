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
  verificationCleanupIssues?: Array<{
    code: "cleanup_failed";
    detail: string;
  }>;
  now?: () => number;
  plannerNeverResolves?: boolean;
  afterPlan?: () => void;
  afterGeneration?: () => void;
  duringVerification?: (remainingMs: number) => void;
  taskBudgetMs?: number;
  generationResourceViolation?: boolean;
  generationInventoryError?: boolean;
  afterDispose?: () => void;
} = {}) {
  const repository = new SqliteRunRepository(":memory:");
  const events = new RunEventBus();
  const activeTask: TaskManifest = {
    ...task,
    budget: {
      ...task.budget,
      totalMs: options.taskBudgetMs ?? task.budget.totalMs,
    },
  };
  const observedVerificationStages: string[] = [];
  const generationCleanup: string[] = [];
  const planner: PlannerPort & { calls: unknown[] } = {
    calls: [],
    async plan(input) {
      this.calls.push(input);
      if (options.plannerNeverResolves) {
        return new Promise<never>(() => undefined);
      }
      options.afterPlan?.();
      return plan;
    },
  };
  const generator: GeneratorPort & { calls: unknown[] } = {
    calls: [],
    async generate(input) {
      this.calls.push(input);
      if (options.generatorError) throw options.generatorError;
      options.afterGeneration?.();
      return {
        stdout: "generated",
        stderr: "",
        events: options.generationResourceViolation
          ? [
              {
                type: "item.completed",
                item: {
                  type: "mcp_tool_call",
                  server: "solari",
                  tool: "solari_desktop_create",
                  result: { sessionId: "desktop-1" },
                },
              },
            ]
          : options.generationInventoryError
            ? [
                {
                  type: "item.completed",
                  item: {
                    type: "mcp_tool_call",
                    server: "solari",
                    tool: "solari_sandbox_create",
                    result: { sandboxId: "sandbox-from-event" },
                  },
                },
              ]
          : [],
      };
    },
  };
  const verifier: VerifierRegistryPort & { calls: unknown[] } = {
    calls: [],
    async verify(input) {
      this.calls.push(input);
      options.duringVerification?.(input.remainingMs());
      for (const stage of [
        "provisioning",
        "building",
        "verifying",
        "capturing",
      ] as const) {
        input.onStage(stage);
        observedVerificationStages.push(
          repository.get(input.run.id)?.stage ?? "missing",
        );
      }
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
        cleanupIssues: options.verificationCleanupIssues,
      };
    },
  };
  const workspace: DisposableWorkspace & { disposed: boolean } = {
    root: "C:\\temp\\agentbench-test",
    disposed: false,
    async dispose() {
      this.disposed = true;
      if (options.disposeError) throw options.disposeError;
      options.afterDispose?.();
    },
  };
  let workspaceCalls = 0;
  let sandboxLists = 0;
  let desktopLists = 0;
  const generationResources =
    options.generationResourceViolation || options.generationInventoryError
    ? {
        services: {
          browser: {
            async listIds() {
              return [];
            },
            async release(id: string) {
              generationCleanup.push(`browser:${id}`);
            },
          },
          sandbox: {
            async listIds() {
              sandboxLists += 1;
              if (options.generationInventoryError && sandboxLists === 2) {
                throw new Error("inventory unavailable");
              }
              return sandboxLists === 1 ? [] : ["sandbox-1", "sandbox-2"];
            },
            async kill(id: string) {
              generationCleanup.push(`sandbox:${id}`);
            },
          },
          desktop: {
            async listIds() {
              desktopLists += 1;
              return desktopLists === 1 ? [] : ["desktop-1"];
            },
            async kill(id: string) {
              generationCleanup.push(`desktop:${id}`);
            },
          },
        },
      }
    : undefined;
  const orchestrator = new AgentBenchOrchestrator({
    repository,
    events,
    planner,
    generator,
    verifier,
    getTask: () => activeTask,
    getAgent: () => agent,
    createWorkspace: async () => {
      workspaceCalls += 1;
      return workspace;
    },
    packageSubmission: async () => ({
      entries: {
        "results.json": { kind: "text" as const, contents: "{}" },
      },
      digest: "digest",
    }),
    schemaPath: "C:\\schemas\\run-plan.schema.json",
    solariApiKey: "test-key",
    now: options.now,
    generationResources: generationResources as never,
  });
  return {
    repository,
    events,
    planner,
    generator,
    verifier,
    workspace,
    orchestrator,
    observedVerificationStages,
    generationCleanup,
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
  expect(harness.observedVerificationStages).toEqual([
    "provisioning",
    "building",
    "verifying",
    "capturing",
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

test("passes one shrinking total deadline through planning, generation, and verification", async () => {
  let now = 1_000;
  let verifierRemaining = 0;
  const harness = createHarness({
    taskBudgetMs: 1_000,
    now: () => now,
    afterPlan: () => {
      now += 100;
    },
    afterGeneration: () => {
      now += 250;
    },
    duringVerification: (remainingMs) => {
      verifierRemaining = remainingMs;
      now += 200;
    },
  });

  const run = await harness.orchestrator.run({
    taskId: "url-shortener",
    agentId: "sol-low",
  });

  expect(harness.planner.calls[0]).toMatchObject({ timeoutMs: 1_000 });
  expect(harness.generator.calls[0]).toMatchObject({ timeoutMs: 900 });
  expect(verifierRemaining).toBe(650);
  expect(run).toMatchObject({
    stage: "completed",
    durationMs: 550,
    score: { budget: 5, total: 100 },
  });
  harness.repository.close();
});

test("fails when the single total run deadline is exhausted between stages", async () => {
  let now = 10_000;
  const harness = createHarness({
    taskBudgetMs: 100,
    now: () => now,
    afterGeneration: () => {
      now += 101;
    },
  });

  const run = await harness.orchestrator.run({
    taskId: "url-shortener",
    agentId: "sol-low",
  });

  expect(run).toMatchObject({
    stage: "failed",
    failureCode: "agent_timeout",
  });
  expect(harness.verifier.calls).toHaveLength(0);
  harness.repository.close();
});

test("enforces the total deadline even when a planner ignores its process timeout", async () => {
  const harness = createHarness({
    plannerNeverResolves: true,
    taskBudgetMs: 10,
  });

  const outcome = await Promise.race([
    harness.orchestrator.run({
      taskId: "url-shortener",
      agentId: "sol-low",
    }),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100)),
  ]);

  expect(outcome).not.toBe("hung");
  expect(outcome).toMatchObject({
    stage: "failed",
    failureCode: "agent_timeout",
  });
  harness.repository.close();
});

test("propagates verifier cleanup issues into the run and cleanup event stream", async () => {
  const harness = createHarness({
    verificationCleanupIssues: [
      { code: "cleanup_failed", detail: "sandbox sandbox-1: kill failed" },
    ],
  });

  const run = await harness.orchestrator.run({
    taskId: "url-shortener",
    agentId: "sol-low",
  });

  expect(run.cleanupIssues).toEqual([
    { code: "cleanup_failed", detail: "sandbox sandbox-1: kill failed" },
  ]);
  expect(
    harness.repository
      .listEvents(run.id)
      .filter((event) => event.kind === "cleanup")
      .map((event) => event.payload),
  ).toEqual([
    { code: "cleanup_failed", detail: "sandbox sandbox-1: kill failed" },
  ]);
  harness.repository.close();
});

test("fails closed and cleans every generated resource after an MCP policy violation", async () => {
  const harness = createHarness({ generationResourceViolation: true });

  const run = await harness.orchestrator.run({
    taskId: "url-shortener",
    agentId: "sol-low",
  });

  expect(run).toMatchObject({
    stage: "failed",
    failureCode: "agent_failed",
  });
  expect(run.failureDetail).toMatch(/desktop primitive was not approved/i);
  expect(run.failureDetail).toMatch(/sandbox primitive created 2 resources/i);
  expect(harness.generationCleanup).toEqual([
    "desktop:desktop-1",
    "sandbox:sandbox-1",
    "sandbox:sandbox-2",
  ]);
  expect(harness.verifier.calls).toHaveLength(0);
  harness.repository.close();
});

test("fails closed and cleans event-reported resources when post-generation inventory fails", async () => {
  const harness = createHarness({ generationInventoryError: true });

  const run = await harness.orchestrator.run({
    taskId: "url-shortener",
    agentId: "sol-low",
  });

  expect(run).toMatchObject({
    stage: "failed",
    failureCode: "agent_failed",
  });
  expect(run.failureDetail).toMatch(/inventory unavailable/i);
  expect(run.cleanupIssues).toEqual([
    {
      code: "cleanup_failed",
      detail: expect.stringMatching(/inventory unavailable/i),
    },
  ]);
  expect(harness.generationCleanup).toEqual(["sandbox:sandbox-from-event"]);
  expect(harness.verifier.calls).toHaveLength(0);
  harness.repository.close();
});

test("scores the budget from total orchestration duration including cleanup", async () => {
  let now = 20_000;
  const harness = createHarness({
    taskBudgetMs: 1_000,
    now: () => now,
    afterDispose: () => {
      now += 1_001;
    },
  });

  const run = await harness.orchestrator.run({
    taskId: "url-shortener",
    agentId: "sol-low",
  });

  expect(run).toMatchObject({
    stage: "completed",
    durationMs: 1_001,
    score: { budget: 0, total: 95 },
  });
  harness.repository.close();
});
