import { expect, test } from "vitest";
import type { BenchmarkDefinition } from "@/core/benchmarks/types";
import type { AgentConfig } from "@/core/domain/run";
import type { TaskManifest } from "@/core/domain/task";
import { RunEventBus } from "@/core/events/run-events";
import { SqliteRunRepository } from "@/core/persistence/sqlite-repository";
import type { RunSelection } from "@/core/runner/contracts";
import { RunQueue } from "@/core/runner/queue";
import { createRunSubmitter } from "@/server/container";

const task: TaskManifest = {
  id: "url-shortener",
  version: "1.0.0",
  title: "URL Shortener",
  prompt: "Prompt captured during selection.",
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
  tasks: [],
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

test("the deferred server queue passes the exact created selection to runCreated", async () => {
  const repository = new SqliteRunRepository(":memory:");
  const events = new RunEventBus();
  const queue = new RunQueue(1);
  let releaseBlocker!: () => void;
  let markBlockerStarted!: () => void;
  const blockerStarted = new Promise<void>((resolve) => {
    markBlockerStarted = resolve;
  });
  const blocker = queue.enqueue(
    () =>
      new Promise<void>((resolve) => {
        releaseBlocker = resolve;
        markBlockerStarted();
      }),
  );
  await blockerStarted;

  let sourcePrompt = task.prompt;
  let resolutionCalls = 0;
  let createdSelection: RunSelection | undefined;
  let receivedSelection: RunSelection | undefined;
  let markWorkerDone!: () => void;
  const workerDone = new Promise<void>((resolve) => {
    markWorkerDone = resolve;
  });
  const orchestrator = {
    async dryRun() {
      throw new Error("not used");
    },
    async create() {
      resolutionCalls += 1;
      createdSelection = {
        benchmark,
        snapshot: {
          digest: "snapshot-digest",
          root: "C:\\snapshots\\snapshot-digest",
          files: [],
        },
        task: { ...task, prompt: sourcePrompt },
        agent,
      };
      const queued = repository.create({
        taskId: task.id,
        taskVersion: task.version,
        agentId: agent.id,
        model: agent.model,
        reasoningEffort: agent.reasoningEffort,
        benchmarkId: benchmark.id,
        benchmarkVersion: benchmark.version,
        benchmarkDigest: createdSelection.snapshot.digest,
        snapshotPath: createdSelection.snapshot.root,
        providerId: benchmark.agents[0].provider,
        harnessId: benchmark.agents[0].harness.id,
        harnessVersion: benchmark.agents[0].harness.version,
      });
      return {
        run: repository.update(queued.id, { stage: "loading" }),
        selection: createdSelection,
      };
    },
    async runCreated(id: string, selection: RunSelection) {
      receivedSelection = selection;
      markWorkerDone();
      return repository.update(id, { stage: "completed" });
    },
  };
  const submit = createRunSubmitter({
    executionOrchestrator: () => orchestrator,
    queue,
    repository,
    events,
  });

  try {
    const submission = await submit({
      benchmarkId: benchmark.id,
      taskId: task.id,
      agentId: agent.id,
    });
    sourcePrompt = "Prompt from an alternate resolution after enqueue.";
    expect(submission).toMatchObject({ kind: "run", run: { stage: "loading" } });
    expect(receivedSelection).toBeUndefined();

    releaseBlocker();
    await Promise.all([blocker, workerDone]);

    expect(resolutionCalls).toBe(1);
    expect(receivedSelection).toBe(createdSelection);
    expect(receivedSelection?.task).toBe(createdSelection?.task);
    expect(receivedSelection?.agent).toBe(createdSelection?.agent);
    expect(receivedSelection?.task.prompt).toBe("Prompt captured during selection.");
  } finally {
    releaseBlocker?.();
    await blocker;
    repository.close();
  }
});
