import { expect, test } from "vitest";
import type { BenchmarkSnapshot } from "@/core/benchmarks/snapshot";
import type { BenchmarkDefinition } from "@/core/benchmarks/types";
import { AgentFailedError } from "@/core/providers/errors";
import { AgentProviderRegistry } from "@/core/providers/registry";
import type { AgentProvider } from "@/core/providers/types";
import type { RunPlan } from "@/core/domain/plan";
import type { AgentConfig } from "@/core/domain/run";
import type { TaskManifest } from "@/core/domain/task";
import { RunEventBus } from "@/core/events/run-events";
import { SqliteRunRepository } from "@/core/persistence/sqlite-repository";
import type { DisposableWorkspace } from "@/core/security/workspace";
import type { RunSelection, VerifierRegistryPort } from "@/core/runner/contracts";
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

const benchmark: BenchmarkDefinition = {
  schemaVersion: 1,
  id: "agentbench-live",
  name: "AgentBench Live",
  version: "1.0.0",
  root: "C:\\benchmarks\\agentbench-live",
  defaults: {
    timeoutSeconds: 300,
    maxConcurrency: 1,
    submissionDirectory: "submission",
  },
  tasks: [
    {
      id: task.id,
      name: task.title,
      promptPath: "tasks/url-shortener/prompt.md",
      prompt: task.prompt,
      fixtures: [],
      allowedPrimitives: task.allowedPrimitives,
      planningRequired: true,
      resourceLimits: {
        browserSessions: 1,
        sandboxes: 1,
        desktops: 1,
        totalMinutes: 5,
      },
      submission: { directory: "submission", required: ["results.json"] },
      evaluators: [],
    },
  ],
  agents: [
    {
      id: agent.id,
      name: agent.label,
      provider: "codex",
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
      harness: { id: "codex-sdk", version: "local" },
      options: {},
    },
  ],
};

const snapshot: BenchmarkSnapshot = {
  digest: "snapshot-digest",
  root: "C:\\snapshots\\snapshot-digest",
  files: [],
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
  generatorNeverResolves?: boolean;
  afterPlan?: () => void;
  afterGeneration?: () => void;
  duringVerification?: (remainingMs: number) => void;
  taskBudgetMs?: number;
  generationResourceViolation?: boolean;
  generationInventoryError?: boolean;
  lateProvision?: () => Promise<{ kill(): Promise<void> }>;
  lateGenerationResourceMs?: number;
  cleanupGraceMs?: number;
  afterDispose?: () => void;
  resolveSelection?: (request: {
    benchmarkId?: string;
    taskId: string;
    agentId: string;
  }) => Promise<RunSelection>;
  selectionError?: Error;
} = {}) {
  const repository = new SqliteRunRepository(":memory:");
  const events = new RunEventBus();
  const operationOrder: string[] = [];
  const activeTask: TaskManifest = {
    ...task,
    budget: {
      ...task.budget,
      totalMs: options.taskBudgetMs ?? task.budget.totalMs,
    },
  };
  const observedVerificationStages: string[] = [];
  const generationCleanup: string[] = [];
  let prepareProviderResources = () => undefined;
  const planCalls: unknown[] = [];
  const executeCalls: unknown[] = [];
  let cancellationCalls = 0;
  const provider: AgentProvider = {
    describe: () => ({
      id: "codex",
      name: "Fake Codex",
      adapterVersion: "test",
      capabilities: { planning: true, streaming: true, tools: true, structuredCompletion: false },
      optionsSchema: { type: "object" },
    }),
    async preflight() {
      return { ok: true };
    },
    async plan(input) {
      planCalls.push({ ...input, timeoutMs: input.remainingMs() });
      operationOrder.push("planning");
      if (options.plannerNeverResolves) {
        return new Promise<never>(() => undefined);
      }
      options.afterPlan?.();
      return plan;
    },
    async execute(input, sink) {
      executeCalls.push({ ...input, timeoutMs: input.remainingMs() });
      operationOrder.push("generation");
      const result = (async () => {
        await sink.emit("message", { text: "provider progress" });
        if (options.generatorNeverResolves) {
          return await new Promise<never>(() => undefined);
        }
        if (options.generatorError) throw options.generatorError;
        if (options.lateGenerationResourceMs !== undefined) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, options.lateGenerationResourceMs));
        }
        prepareProviderResources();
        options.afterGeneration?.();
        if (options.generationResourceViolation) {
          throw new AgentFailedError(
            "desktop primitive was not approved; sandbox primitive created 2 resources (maximum 1)",
            "codex",
          );
        }
        if (options.generationInventoryError) {
          throw new AgentFailedError("inventory unavailable", "codex");
        }
        return {
          resolvedModel: input.agent.model,
          usage: { inputTokens: 10, outputTokens: 4 },
          finalResponse: "generated",
        };
      })();
      return { handle: { id: "fake-run" }, result };
    },
    async cancel() { cancellationCalls += 1; },
  };
  const providers = new AgentProviderRegistry();
  providers.register("codex", provider);
  const planner = { calls: planCalls };
  const generator = { calls: executeCalls };
  const verifier: VerifierRegistryPort & { calls: unknown[] } = {
    calls: [],
    async verify(input) {
      this.calls.push(input);
      operationOrder.push("verification");
      if (options.lateProvision) {
        input.onStage("provisioning");
        await input.acquireWithDeadline(
          "late sandbox provisioning",
          options.lateProvision,
          (handle) => handle.kill(),
        );
      }
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
  let selectionCalls = 0;
  const preflightSelections: RunSelection[] = [];
  const sandboxLists = 0;
  const orchestrator = new AgentBenchOrchestrator({
    repository,
    events,
    providers,
    credentials: {
      listMetadata: async () => [],
      has: async () => true,
      withCredential: async () => { throw new Error("not used"); },
    },
    createToolBroker: ({ supervisor }) => {
      prepareProviderResources = () => {
        if (options.generationResourceViolation) {
          supervisor.trackDesktop({
            id: "desktop-1",
            kill: async () => { generationCleanup.push("desktop:desktop-1"); },
          });
          for (const id of ["sandbox-1", "sandbox-2"]) {
            supervisor.trackSandbox({
              id,
              kill: async () => { generationCleanup.push(`sandbox:${id}`); },
            });
          }
        } else if (options.generationInventoryError) {
          supervisor.trackSandbox({
            id: "sandbox-from-event",
            kill: async () => {
              generationCleanup.push("sandbox:sandbox-from-event");
              throw new Error("inventory unavailable");
            },
          });
        } else if (options.lateGenerationResourceMs !== undefined) {
          supervisor.trackSandbox({
            id: "sandbox-late",
            kill: async () => { generationCleanup.push("sandbox:sandbox-late"); },
          });
        }
      };
      return { listDefinitions: () => [], invoke: async () => undefined };
    },
    verifier,
    resolveSelection: async (request) => {
      selectionCalls += 1;
      if (options.selectionError) throw options.selectionError;
      const selection = options.resolveSelection
        ? options.resolveSelection(request)
        : { benchmark, snapshot, task: activeTask, agent };
      const resolved = await selection;
      operationOrder.push("selection-resolved");
      return resolved;
    },
    preflight: async (selection) => {
      preflightSelections.push(selection);
      operationOrder.push("preflight");
    },
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
    now: options.now,
    cleanupGraceMs: options.cleanupGraceMs,
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
    get sandboxLists() {
      return sandboxLists;
    },
    get selectionCalls() {
      return selectionCalls;
    },
    get cancellationCalls() {
      return cancellationCalls;
    },
    preflightSelections,
    operationOrder,
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
    if (event.kind === "stage") seen.push(String(event.payload.stage));
    originalPublish(runId, event);
  };
  const run = await harness.orchestrator.run({
    taskId: "url-shortener",
    agentId: "sol-low",
  });
  expect(run).toMatchObject({ stage: "completed", score: { total: 100 } });
  expect(seen).toEqual([
    "loading",
    "preflight",
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

test("creates a durable loading run with snapshot and provider identity before executing it", async () => {
  const harness = createHarness();
  const request = {
    benchmarkId: "agentbench-live",
    taskId: "url-shortener",
    agentId: "sol-low",
  };

  const created = await harness.orchestrator.create(request);
  expect(created.run).toMatchObject({
    taskId: request.taskId,
    agentId: request.agentId,
    stage: "loading",
    benchmarkId: "agentbench-live",
    benchmarkVersion: "1.0.0",
    benchmarkDigest: "snapshot-digest",
    snapshotPath: "C:\\snapshots\\snapshot-digest",
    providerId: "codex",
    harnessId: "codex-sdk",
    harnessVersion: "local",
  });

  const completed = await harness.orchestrator.runCreated(
    created.run.id,
    created.selection,
  );
  expect(completed).toMatchObject({ id: created.run.id, stage: "completed" });
  expect(harness.repository.list()).toHaveLength(1);
  harness.repository.close();
});

test("persists and publishes the identical normalized provider event envelope", async () => {
  const harness = createHarness();
  const published: unknown[] = [];
  const originalPublish = harness.events.publish.bind(harness.events);
  harness.events.publish = (runId, event) => {
    if (event.kind === "provider_event") published.push(event);
    originalPublish(runId, event);
  };

  const run = await harness.orchestrator.run({
    taskId: "url-shortener",
    agentId: "sol-low",
  });

  const persisted = harness.repository
    .listEvents(run.id)
    .filter((event) => event.kind === "provider_event");
  expect(persisted).toHaveLength(1);
  expect(published).toEqual(persisted);
  expect(persisted[0].payload).toEqual(expect.objectContaining({
    schemaVersion: 1,
    sequence: 1,
    kind: "message",
    provider: "codex",
    payload: { text: "provider progress" },
  }));
  expect(run).toMatchObject({
    resolvedModel: "gpt-5.6-sol",
    providerOptions: {},
    toolPolicy: { primitives: ["sandbox", "browser"] },
    usage: { inputTokens: 10, outputTokens: 4 },
  });
  harness.repository.close();
});

test("aborts and cancels the provider once when execution exceeds the run deadline", async () => {
  const harness = createHarness({ generatorNeverResolves: true, taskBudgetMs: 20 });

  const run = await harness.orchestrator.run({
    taskId: "url-shortener",
    agentId: "sol-low",
  });

  expect(run).toMatchObject({ stage: "failed", failureCode: "agent_timeout" });
  expect(harness.cancellationCalls).toBe(1);
  harness.repository.close();
});

test("passes the exact selection created from the snapshot through preflight, planning, and generation", async () => {
  let sourcePrompt = "Prompt captured before the source edit.";
  let selected: RunSelection | undefined;
  const harness = createHarness({
    resolveSelection: async () => {
      selected = {
        benchmark,
        snapshot,
        task: { ...task, prompt: sourcePrompt },
        agent,
      };
      return selected;
    },
  });

  const created = await harness.orchestrator.create({
    benchmarkId: "agentbench-live",
    taskId: task.id,
    agentId: agent.id,
  });
  expect(harness.operationOrder).toEqual(["selection-resolved"]);
  sourcePrompt = "Prompt edited after create().";
  const completed = await harness.orchestrator.runCreated(
    created.run.id,
    created.selection,
  );

  expect(completed.stage).toBe("completed");
  expect(harness.selectionCalls).toBe(1);
  expect(created.selection).toBe(selected);
  expect(harness.preflightSelections).toHaveLength(1);
  expect(harness.preflightSelections[0]).toBe(created.selection);
  expect(harness.preflightSelections[0].task).toBe(created.selection.task);
  expect(harness.preflightSelections[0].agent).toBe(created.selection.agent);

  const plannerInput = harness.planner.calls[0] as {
    task: { prompt: string };
    agent: { id: string };
  };
  expect(plannerInput.task.prompt).toBe(created.selection.task.prompt);
  expect(plannerInput.agent.id).toBe(created.selection.agent.id);
  expect(plannerInput.task.prompt).toBe(
    "Prompt captured before the source edit.",
  );

  const generatorInput = harness.generator.calls[0] as {
    agent: { id: string };
    task: { prompt: string };
  };
  expect(generatorInput.agent.id).toBe(created.selection.agent.id);
  expect(generatorInput.task.prompt).toBe(
    "Prompt captured before the source edit.",
  );

  const verifierInput = harness.verifier.calls[0] as {
    task: TaskManifest;
    agent: AgentConfig;
  };
  expect(verifierInput.task).toBe(created.selection.task);
  expect(verifierInput.agent).toBe(created.selection.agent);
  expect(harness.operationOrder).toEqual([
    "selection-resolved",
    "preflight",
    "planning",
    "generation",
    "verification",
  ]);
  harness.repository.close();
});

test("does not create a run or invoke provider and Solari ports when benchmark loading fails", async () => {
  const harness = createHarness({
    selectionError: new Error("benchmark_invalid"),
    generationResourceViolation: true,
  });

  await expect(
    harness.orchestrator.create({
      benchmarkId: "broken-pack",
      taskId: task.id,
      agentId: agent.id,
    }),
  ).rejects.toThrow(/benchmark_invalid/);

  expect(harness.repository.list()).toHaveLength(0);
  expect(harness.preflightSelections).toHaveLength(0);
  expect(harness.planner.calls).toHaveLength(0);
  expect(harness.generator.calls).toHaveLength(0);
  expect(harness.verifier.calls).toHaveLength(0);
  expect(harness.workspaceCalls).toBe(0);
  expect(harness.sandboxLists).toBe(0);
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

test("awaits cleanup of a provisioning handle that resolves after the run deadline", async () => {
  vi.useFakeTimers();
  let signalProvisioningStarted!: () => void;
  const provisioningStarted = new Promise<void>((resolve) => {
    signalProvisioningStarted = resolve;
  });
  let resolveProvisioningHandle!: (
    handle: { kill(): Promise<void> },
  ) => void;
  const provisioningHandle = new Promise<{ kill(): Promise<void> }>(
    (resolve) => {
      resolveProvisioningHandle = resolve;
    },
  );
  let lateProvisionKills = 0;
  const lateHandle = {
    async kill() {
      lateProvisionKills += 1;
    },
  };
  const harness = createHarness({
    taskBudgetMs: 20,
    cleanupGraceMs: 100,
    lateProvision: () => {
      signalProvisioningStarted();
      return provisioningHandle;
    },
  });

  const runPromise = harness.orchestrator.run({
    taskId: "url-shortener",
    agentId: "sol-low",
  });
  let runSettled = false;
  void runPromise.then(
    () => {
      runSettled = true;
    },
    () => {
      runSettled = true;
    },
  );

  try {
    await provisioningStarted;
    await vi.advanceTimersByTimeAsync(20);

    expect(runSettled).toBe(false);

    resolveProvisioningHandle(lateHandle);
    const run = await runPromise;

    expect(run).toMatchObject({
      stage: "failed",
      failureCode: "agent_timeout",
    });
    expect(lateProvisionKills).toBe(1);
  } finally {
    resolveProvisioningHandle(lateHandle);
    await runPromise;
    harness.repository.close();
    vi.useRealTimers();
  }
});

test("uses cleanup grace for inventory and teardown after generation exceeds the deadline", async () => {
  let now = 30_000;
  const harness = createHarness({
    taskBudgetMs: 1_000,
    now: () => now,
    lateGenerationResourceMs: 1,
    afterGeneration: () => {
      now += 1_001;
    },
    cleanupGraceMs: 50,
  });

  const run = await harness.orchestrator.run({
    taskId: "url-shortener",
    agentId: "sol-low",
  });

  expect(run).toMatchObject({
    stage: "failed",
    failureCode: "agent_timeout",
  });
  expect(harness.generationCleanup).toEqual(["sandbox:sandbox-late"]);
  expect(harness.verifier.calls).toHaveLength(0);
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
