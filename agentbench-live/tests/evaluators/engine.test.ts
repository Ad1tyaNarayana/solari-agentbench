import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvaluationEngine } from "@/core/evaluators/engine";
import { EvaluatorRegistry } from "@/core/evaluators/registry";

test("runs a generic evaluator graph and always disposes its runtime", async () => {
  const registry = new EvaluatorRegistry();
  registry.register("file", { type: "file", validate() {}, async evaluate() { return { status: "passed", earnedFraction: 1, summary: "ok", assertions: [], evidence: [], outputs: {}, metadata: {} }; } });
  const kill = vi.fn(async () => undefined);
  const services = { sandbox: { create: vi.fn(async () => ({ id: "s", kill })) }, browser: {}, desktop: {} };
  const root = await mkdtemp(join(tmpdir(), "agentbench-engine-"));
  const engine = new EvaluationEngine({ registry, services: services as never, providers: {} as never, credentials: {} as never, evidenceRoot: root });
  const result = await engine.run({ runId: "r", taskId: "t", definitions: [{ id: "file", type: "file", weight: 100, enabled: true, prerequisites: [], config: {} }], submission: { digest: "x", entries: {} }, snapshot: { digest: "s", root, files: [] }, remainingMs: () => 1000 });
  expect(result.report).toMatchObject({ status: "valid-score", score: 100 });
  expect(result.manifest).toMatchObject({ runId: "r", taskId: "t" });
});
