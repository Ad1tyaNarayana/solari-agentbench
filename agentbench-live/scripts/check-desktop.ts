/** A bounded live capture diagnostic; never a model benchmark score. */
import { resolve } from "node:path";
import { createSolariServices } from "../src/core/solari/clients";
import { SqliteRunRepository } from "../src/core/persistence/sqlite-repository";
import { EvidenceStore } from "../src/core/evidence/store";
import { redactCredentialText } from "../src/core/credentials/redaction";

if (!process.argv.includes("--yes") || !process.env.SOLARI_API_KEY) throw new Error("Needs SOLARI_API_KEY and --yes; provisions one desktop for up to 60 seconds.");
const services = createSolariServices(process.env.SOLARI_API_KEY);
const repository = new SqliteRunRepository(resolve(".agentbench/agentbench.sqlite"));
const run = repository.create({ taskId: "desktop-capture-check", agentId: "reference-evidence-check", harnessId: "reference-infrastructure-check", harnessVersion: "1" });
const store = new EvidenceStore({ root: resolve(".agentbench/evidence"), runId: run.id, taskId: run.taskId, exactSecretValues: [process.env.SOLARI_API_KEY] });
const started = Date.now();
repository.update(run.id, { stage: "capturing", startedAt: new Date().toISOString() });
let desktop;
try {
  desktop = await services.desktop.create({ timeoutMs: 60000, resolution: "1280x720" });
  const health = await desktop.health();
  await store.putJson({ mimeType: "application/json", role: "desktop-health", producer: "evaluator", value: health });
  if (!health.ready || !health.display) throw new Error("Desktop display was not ready");
  const bytes = await desktop.screenshot();
  if (Buffer.from(bytes).subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Desktop did not return a PNG");
  await store.putBytes({ mimeType: "image/png", role: "desktop-screenshot", producer: "evaluator", bytes });
  repository.update(run.id, { stage: "completed", sanitizedLogs: ["Live desktop screenshot check. No agent task or score. Not a desktop video recording."] });
} catch (error) {
  repository.update(run.id, { stage: "failed", failureCode: "evidence_failed", failureDetail: redactCredentialText(error instanceof Error ? error.message : String(error)) });
} finally {
  try { await desktop?.kill(); }
  catch { repository.update(run.id, { stage: "failed", cleanupIssues: [{ code: "cleanup_failed", detail: "Desktop cleanup failed; inspect the console." }] }); }
  repository.update(run.id, { completedAt: new Date().toISOString(), durationMs: Date.now() - started, evidenceManifest: await store.readManifest() });
  console.log(JSON.stringify({ url: `http://127.0.0.1:3000/runs/${run.id}`, stage: repository.get(run.id)?.stage, artifacts: (await store.readManifest()).entries.map(e => ({ role: e.role, bytes: e.size })) }));
  await services.dispose?.();
  repository.close();
}
