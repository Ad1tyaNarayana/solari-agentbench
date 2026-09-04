import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AuthoringService } from "@/core/authoring/service";
import type { BenchmarkDraft } from "@/core/authoring/types";
import { BenchmarkCatalog } from "@/core/benchmarks/catalog";
import { BenchmarkLoader } from "@/core/benchmarks/loader";
import { RunEventBus } from "@/core/events/run-events";
import { createBuiltinEvaluatorRegistry } from "@/core/evaluators/builtins";
import { EvaluationEngine } from "@/core/evaluators/engine";
import { SqliteRunRepository } from "@/core/persistence/sqlite-repository";
import { ExecutableJsonlProvider } from "@/core/providers/executable-jsonl";
import { AgentProviderRegistry } from "@/core/providers/registry";
import { AgentBenchOrchestrator } from "@/core/runner/orchestrator";
import { defaultSubmissionPolicy, packageSubmission } from "@/core/security/package-submission";
import { createWorkspace } from "@/core/security/workspace";

const temporaryRoots: string[] = [];
afterEach(async () => Promise.all(temporaryRoots.splice(0).map((root) =>
  rm(root, { recursive: true, force: true }),
)));

test("Studio's saved snapshot digest survives the complete production orchestrator path", async () => {
  const root = await temporaryDirectory("agentbench-studio-e2e-");
  const snapshots = join(root, ".snapshots");
  const evidence = join(root, ".evidence");
  const harness = resolve("tests/fixtures/providers/studio-jsonl-agent.mjs");
  const draft: BenchmarkDraft = {
    schemaVersion: 1,
    id: "roundtrip-bench",
    name: "Roundtrip",
    version: "1.0.0",
    defaults: { timeoutSeconds: 60, maxConcurrency: 1, submissionDirectory: "submission" },
    tasks: [{
      id: "task", name: "Task", prompt: "Create results.json", fixtures: [],
      allowedPrimitives: [], planningRequired: true,
      resourceLimits: { browserSessions: 0, sandboxes: 0, desktops: 0, totalMinutes: 1 },
      submission: { directory: "submission", required: ["results.json"] },
      evaluationPolicy: { maxModelJudgeWeight: 30, allowModelJudgeMajority: false },
      evaluators: [{ id: "result", type: "file", weight: 100, enabled: true, prerequisites: [], config: { subject: "results.json", assertion: "present" } }],
    }],
    agents: [{
      id: "fixture", name: "Fixture", provider: "executable-jsonl",
      harness: { id: "jsonl", version: "1" },
      options: { command: [process.execPath, harness] },
    }],
  };
  const authoring = new AuthoringService({ writableRoots: [root], snapshotsRoot: snapshots });
  const created = await authoring.create({ draft });
  const packRoot = await authoring.getPackRoot(draft.id);
  const catalog = new BenchmarkCatalog([packRoot], new BenchmarkLoader(snapshots));
  const loaded = await catalog.getBenchmark(draft.id);
  const repository = new SqliteRunRepository(":memory:");
  const providers = new AgentProviderRegistry();
  providers.register("executable-jsonl", new ExecutableJsonlProvider({ createHandleId: () => "studio-fixture" }));
  const services = { browser: {}, sandbox: {}, desktop: {} };
  const registry = createBuiltinEvaluatorRegistry(services as never);
  const evaluator = new EvaluationEngine({ registry, services: services as never, providers, credentials: emptyCredentials, evidenceRoot: evidence });
  const orchestrator = new AgentBenchOrchestrator({
    repository,
    events: new RunEventBus(),
    providers,
    credentials: emptyCredentials,
    createToolBroker: () => ({ listDefinitions: () => [], invoke: async () => undefined }),
    evaluator,
    resolveSelection: (request) => catalog.resolveSelection(request),
    preflight: async (selection) => {
      const manifest = JSON.parse(await readFile(join(selection.snapshot.root, "manifest.json"), "utf8"));
      expect(manifest.digest).toBe(created.snapshotDigest);
    },
    createWorkspace,
    packageSubmission: (workspace) => packageSubmission(workspace, defaultSubmissionPolicy),
  });

  try {
    const run = await orchestrator.run({ benchmarkId: draft.id, taskId: "task", agentId: "fixture" });
    expect(run.stage, JSON.stringify({ failureCode: run.failureCode, failureDetail: run.failureDetail })).toBe("completed");
    expect(run.benchmarkDigest).toBe(created.snapshotDigest);
    expect(run.benchmarkDigest).toBe(loaded.snapshot.digest);
    expect(run.evaluationReport?.results[0].evaluatorId).toBe("result");
    expect(run.evidenceManifest?.entries).toEqual(expect.any(Array));
    expect(run.primaryScore).toBe(100);
  } finally {
    repository.close();
  }
});

const emptyCredentials = {
  listMetadata: async () => [],
  has: async () => true,
  withCredential: async () => { throw new Error("not used"); },
};

async function temporaryDirectory(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}
