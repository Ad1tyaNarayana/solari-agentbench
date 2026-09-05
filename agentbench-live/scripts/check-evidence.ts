/** Live infrastructure diagnostic, not a model benchmark. Run with --yes. */
import { resolve } from "node:path";
import { BenchmarkLoader } from "../src/core/benchmarks/loader";
import { EvaluationEngine } from "../src/core/evaluators/engine";
import { createBuiltinEvaluatorRegistry } from "../src/core/evaluators/builtins";
import { createBuiltinProviderRegistry, createDefaultCredentialStore } from "../src/core/providers/builtins";
import { createSolariServices } from "../src/core/solari/clients";
import { defaultSubmissionPolicy, packageSubmissionDirectory } from "../src/core/security/package-submission";
import { SqliteRunRepository } from "../src/core/persistence/sqlite-repository";
import { redactCredentialText } from "../src/core/credentials/redaction";

if (!process.argv.includes("--yes")) throw new Error("This provisions a live Solari sandbox and browser. Pass --yes.");
if (!process.env.SOLARI_API_KEY) throw new Error("SOLARI_API_KEY is required");
const loaded = await new BenchmarkLoader(resolve(".agentbench/snapshots")).load(resolve("benchmarks/tutorials/agentbench-live"));
const task = loaded.definition.tasks.find(task => task.id === "url-shortener")!;
const submission = await packageSubmissionDirectory(resolve("tests/fixtures/url-shortener/passing/submission"), defaultSubmissionPolicy);
const repository = new SqliteRunRepository(resolve(".agentbench/agentbench.sqlite"));
const credentials = createDefaultCredentialStore();
const services = createSolariServices(process.env.SOLARI_API_KEY);
const run = repository.create({ taskId: task.id, agentId: "reference-evidence-check", benchmarkId: loaded.definition.id, benchmarkVersion: loaded.definition.version, benchmarkDigest: loaded.snapshot.digest, snapshotPath: loaded.snapshot.root, harnessId: "reference-infrastructure-check", harnessVersion: "1" });
const started = Date.now();
const deadline = started + task.resourceLimits.totalMinutes * 60000;
repository.update(run.id, { stage: "verifying", startedAt: new Date().toISOString() });
repository.appendEvent(run.id, { kind: "log", payload: { message: "Live reference infrastructure check. No model generated this submission; not an agent benchmark score." } });
console.log(`Evidence check: http://127.0.0.1:3000/runs/${run.id}`);
try {
  const result = await new EvaluationEngine({ services, registry: createBuiltinEvaluatorRegistry(services), providers: createBuiltinProviderRegistry(credentials), credentials, evidenceRoot: resolve(".agentbench/evidence") }).run({ runId: run.id, taskId: task.id, definitions: task.evaluators, snapshotPrefix: task.snapshotPrefix, submission, snapshot: loaded.snapshot, remainingMs: () => Math.max(1, deadline - Date.now()), signal: AbortSignal.timeout(task.resourceLimits.totalMinutes * 60000) });
  const failed = result.report.status !== "valid-score" || result.resourceAudit.cleanupIssues.length > 0;
  repository.update(run.id, { stage: failed ? "failed" : "completed", evaluationReport: result.report, evidenceManifest: result.manifest, evaluationStatus: result.report.status, primaryScore: result.report.score, failureCode: failed ? "evaluator_error" : undefined, failureDetail: failed ? "Reference infrastructure check: inspect evaluator results and retained evidence." : undefined, cleanupIssues: result.resourceAudit.cleanupIssues, toolPolicy: { diagnostic: true, observedResourceCounts: { browsers: result.resourceAudit.created.browsers.length, sandboxes: result.resourceAudit.created.sandboxes.length, desktops: result.resourceAudit.created.desktops.length } }, sanitizedLogs: ["Reference fixture evaluated against live Solari. Not a model benchmark.", `Created ${result.resourceAudit.created.sandboxes.length} sandbox(s) and ${result.resourceAudit.created.browsers.length} browser(s). Cleanup issues: ${result.resourceAudit.cleanupIssues.length}.`] });
  console.log(JSON.stringify({ status: result.report.status, artifacts: result.manifest.entries.map(e => ({ role: e.role, bytes: e.size })), cleanupIssues: result.resourceAudit.cleanupIssues.length }));
} catch (error) {
  const detail = redactCredentialText(error instanceof Error ? error.message : String(error));
  repository.update(run.id, { stage: "failed", failureCode: "evaluator_error", failureDetail: detail });
  console.error(detail);
} finally {
  repository.update(run.id, { completedAt: new Date().toISOString(), durationMs: Date.now() - started });
  await services.dispose?.();
  repository.close();
}
