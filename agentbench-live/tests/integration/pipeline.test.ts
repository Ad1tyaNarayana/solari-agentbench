import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { BenchmarkCatalog } from "@/core/benchmarks/catalog";
import { BenchmarkLoader } from "@/core/benchmarks/loader";
import type { RunPlan } from "@/core/domain/plan";
import { RunEventBus } from "@/core/events/run-events";
import { SqliteRunRepository } from "@/core/persistence/sqlite-repository";
import { AgentProviderRegistry } from "@/core/providers/registry";
import type { AgentProvider } from "@/core/providers/types";
import type { DisposableWorkspace } from "@/core/security/workspace";
import { AgentBenchOrchestrator } from "@/core/runner/orchestrator";
import { runMatrix } from "@/core/runner/matrix";

test.each([false, true])("runs the complete matrix with concurrency one; generic engine=%s", async (generic) => {
  const repository = new SqliteRunRepository(":memory:");
  const snapshotsRoot = await mkdtemp(join(tmpdir(), "agentbench-pipeline-snapshots-"));
  const catalog = new BenchmarkCatalog(
    [resolve("benchmarks/tutorials/agentbench-live")],
    new BenchmarkLoader(snapshotsRoot),
  );
  const preflightDigests: string[] = [];
  let active = 0;
  let peak = 0;
  let clock = 0;
  const provider: AgentProvider = {
    describe: () => ({
      id: "codex", name: "Fake Codex", adapterVersion: "test",
      capabilities: { planning: true, streaming: true, tools: true, structuredCompletion: false },
      optionsSchema: { type: "object" },
    }),
    async preflight() { return { ok: true }; },
    async plan(): Promise<RunPlan> {
      return {
        primitives: ["sandbox"],
        reason: { sandbox: "build and independently verify" },
        verificationStrategy: "fresh execution",
      };
    },
    async execute(input) {
      active += 1;
      peak = Math.max(peak, active);
      return {
        handle: { id: `${input.agent.id}-${input.task.id}` },
        result: new Promise((resolveResult) => setTimeout(() => {
          active -= 1;
          resolveResult({ resolvedModel: input.agent.model });
        }, 5)),
      };
    },
    async cancel() {},
  };
  const providers = new AgentProviderRegistry();
  providers.register("codex", provider);
  const verifier = {
    async verify(context: {
      onStage(stage: "provisioning" | "building" | "verifying" | "capturing"): void;
    }) {
      for (const stage of [
        "provisioning",
        "building",
        "verifying",
        "capturing",
      ] as const) {
        context.onStage(stage);
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
        evidence: { verified: true },
        logs: [],
      };
    },
  };
  const orchestrator = new AgentBenchOrchestrator({
    repository,
    events: new RunEventBus(),
    providers,
    credentials: {
      listMetadata: async () => [], has: async () => true,
      withCredential: async () => { throw new Error("not used"); },
    },
    createToolBroker: () => ({ listDefinitions: () => [], invoke: async () => undefined }),
    verifier,
    evaluator: generic ? { run: async (input) => { clock += 600000; return { report: { status: "valid-score", score: 100, possiblePoints: 100, results: [] }, manifest: { schemaVersion: 1, runId: input.runId, taskId: input.taskId, entries: [] }, resourceAudit: { created: { browsers: [], sandboxes: [], desktops: [] }, cleanupIssues: [{ code: "cleanup_failed", detail: "Evaluator cleanup needs attention" }] } }; } } : undefined,
    now: () => clock,
    resolveSelection: async (request) => {
      const selection = await catalog.resolveSelection(request);
      if (generic) selection.task.budget = { ...selection.task.budget, targetMs: 300000, totalMs: 900000 };
      return selection;
    },
    preflight: async (selection) => {
      const manifest = JSON.parse(
        await readFile(join(selection.snapshot.root, "manifest.json"), "utf8"),
      ) as { digest: string };
      preflightDigests.push(manifest.digest);
    },
    createWorkspace: async (runId): Promise<DisposableWorkspace> => ({
      root: `C:\\temp\\${runId}`,
      async dispose() {},
    }),
    packageSubmission: async () => ({
      entries: {
        "results.json": { kind: "text" as const, contents: "{}" },
      },
      digest: "digest",
    }),
  });

  try {
    const records = await runMatrix(orchestrator, {
      benchmarkId: "agentbench-live",
      confirm: true,
      concurrency: 1,
      agents: await catalog.listAgents(),
      tasks: await catalog.listTasks(),
    });

    expect(records).toHaveLength(4);
    expect(records.map((run) => [run.agentId, run.taskId])).toEqual(
      expect.arrayContaining([
        ["sol-low", "url-shortener"],
        ["sol-low", "same-stats-different-graph"],
        ["luna-high", "url-shortener"],
        ["luna-high", "same-stats-different-graph"],
      ]),
    );
    expect(preflightDigests).toHaveLength(4);
    expect(new Set(preflightDigests)).toEqual(
      new Set(records.map((run) => run.benchmarkDigest)),
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          benchmarkId: "agentbench-live",
          benchmarkVersion: "1.1.0",
          providerId: "codex",
          harnessId: "codex-sdk",
          harnessVersion: "local",
        }),
      ]),
    );
    expect(peak).toBe(1);
    if (generic) for (const run of records) {
      expect(run.cleanupIssues).toEqual([{ code: "cleanup_failed", detail: "Evaluator cleanup needs attention" }]);
      expect(repository.get(run.id)?.score).toEqual({ total: 100, timeAdjusted: 50 });
      expect(repository.get(run.id)?.primaryScore).toBe(100);
    }
  } finally {
    repository.close();
    await rm(snapshotsRoot, { recursive: true, force: true });
  }
});
