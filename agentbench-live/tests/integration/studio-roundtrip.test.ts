import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthoringService } from "@/core/authoring/service";
import { BenchmarkLoader } from "@/core/benchmarks/loader";
import { createBuiltinEvaluatorRegistry } from "@/core/evaluators/builtins";
import { EvaluationEngine } from "@/core/evaluators/engine";
import type { BenchmarkDraft } from "@/core/authoring/types";

const draft: BenchmarkDraft = { schemaVersion: 1, id: "roundtrip-bench", name: "Roundtrip", version: "1.0.0", defaults: { timeoutSeconds: 60, maxConcurrency: 1, submissionDirectory: "submission" }, tasks: [{ id: "task", name: "Task", prompt: "Create result.json", fixtures: [], allowedPrimitives: ["sandbox"], planningRequired: true, resourceLimits: { browserSessions: 0, sandboxes: 1, desktops: 0, totalMinutes: 1 }, submission: { directory: "submission", required: ["result.json"] }, evaluators: [{ id: "result", type: "file", weight: 100, enabled: true, prerequisites: [], config: { subject: "result.json", assertion: "present" } }] }], agents: [{ id: "codex", name: "Codex", provider: "codex", harness: { id: "basic", version: "1" }, options: {} }] };

test("round-trips a Studio pack and evaluates a submission from its immutable snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentbench-studio-e2e-")); const snapshots = join(root, ".snapshots"); const evidence = join(root, ".evidence");
  const authoring = new AuthoringService({ writableRoots: [root], snapshotsRoot: snapshots });
  const created = await authoring.create({ draft }); const packRoot = await authoring.getPackRoot(draft.id); const loaded = await new BenchmarkLoader(snapshots).load(packRoot); const task = loaded.definition.tasks[0];
  const services = { browser: { getReplayUrl: vi.fn() }, sandbox: {}, desktop: {} };
  const engine = new EvaluationEngine({ registry: createBuiltinEvaluatorRegistry(services as never), services: services as never, providers: {} as never, credentials: {} as never, evidenceRoot: evidence });
  const result = await engine.run({ runId: "roundtrip", taskId: task.id, definitions: task.evaluators, snapshotPrefix: task.snapshotPrefix, snapshot: loaded.snapshot, submission: { digest: "submission", entries: { "result.json": { kind: "text", contents: "{}" } } }, remainingMs: () => 10_000 });
  expect(result.report).toMatchObject({ status: "valid-score", score: 100 });
  expect(created.snapshotDigest).toBe(loaded.snapshot.digest);
});
