import { z } from "zod";
import { posix } from "node:path";
import type { EvaluatorDefinition } from "@/core/benchmarks/types";
import { uploadSnapshotTree, uploadTextTree } from "@/core/solari/upload-tree";
import type { Evaluator, EvaluatorContext, EvaluatorOutcome } from "./types";
import { buildInputSeal, verifyInputSeal } from "./input-seal";

const ResultPreview = z.object({
  directory: z.string().refine((value) => {
    const normalized = posix.normalize(value);
    return normalized === value && (normalized === "/result" || normalized.startsWith("/result/"));
  }, "result preview directory must be /result or one of its descendants"),
  port: z.number().int().min(1).max(65535),
  healthPath: z.string().startsWith("/").default("/"),
}).strict();

const Config = z.object({
  argv: z.array(z.string()).min(1).max(256), network: z.boolean().default(false), timeoutMs: z.number().int().positive().max(3_600_000).optional(),
  background: z.boolean().default(false), publishPort: z.number().int().min(1).max(65535).optional(), healthPath: z.string().startsWith("/").optional(),
  resultPreview: ResultPreview.optional(),
}).strict().superRefine((value, context) => {
  if (value.background && value.resultPreview) {
    context.addIssue({ code: "custom", message: "background and resultPreview cannot be combined" });
  }
});
const ResultFile = z.object({
  assertions: z.array(z.object({ id: z.string(), passed: z.boolean(), summary: z.string(), expected: z.unknown().optional(), observed: z.unknown().optional() }).strict()).max(1_000),
  outputs: z.record(z.string(), z.unknown()).default({}), evidence: z.array(z.object({ path: z.string(), role: z.string(), mimeType: z.string() }).strict()).default([]),
}).strict();

async function waitForHealthy(url: string, timeoutMs: number): Promise<void> {
  const healthDeadline = Date.now() + Math.min(timeoutMs, 30_000);
  let lastStatus = "unreachable";
  while (Date.now() < healthDeadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(2_000, Math.max(1, healthDeadline - Date.now()))) });
      lastStatus = String(response.status);
      if (response.ok) return;
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : "unreachable";
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Preview health check failed: ${lastStatus}`);
}

function withPreviewPath(previewUrl: string, path: string): string {
  const url = new URL(previewUrl);
  url.pathname = path;
  url.hash = "";
  return url.toString();
}

export class CommandEvaluator implements Evaluator {
  readonly type = "command" as const;
  validate(definition: EvaluatorDefinition): void { Config.parse(definition.config); }
  async evaluate(definition: EvaluatorDefinition, context: EvaluatorContext, signal: AbortSignal): Promise<EvaluatorOutcome> {
    void signal;
    const config = Config.parse(definition.config);
    const timeoutMs = Math.max(1, Math.min(config.timeoutMs ?? context.remainingMs(), context.remainingMs()));
    const sandbox = await context.resources.acquireSandbox(`evaluator:${definition.id}`, { timeoutMs });
    const inputSeal = buildInputSeal(context.snapshot, context.submission);
    await Promise.all([uploadTextTree(sandbox, context.submission, "/submission"), uploadSnapshotTree(sandbox, context.snapshot)]);
    await sandbox.mkdir("/result");
    const env = { AGENTBENCH_RESULT: "/result/evaluator-result.json" };
    const metadata: Record<string, unknown> = { networkEnabled: config.network };

    const hardened = await sandbox.exec(
      "chmod",
      ["-R", "a-w", "/benchmark", "/submission"],
      { timeoutMs, env: {} },
    );
    if (hardened.exitCode !== 0) {
      throw new Error(
        `Evaluator input permission hardening failed: ${hardened.stderr || `chmod exited with ${hardened.exitCode}`}`,
      );
    }
    context.resources.registerFinalizer(definition.id, async () => {
      let report: Record<string, unknown> & { ok: boolean };
      try {
        report = await verifyInputSeal(sandbox, inputSeal);
      } catch (error) {
        report = {
          schemaVersion: 1,
          ok: false,
          verificationError: error instanceof Error ? error.message : String(error),
        };
      }
      const evidence = await context.evidence.putJson({
        evaluatorId: definition.id,
        mimeType: "application/json",
        role: "input-integrity",
        producer: "evaluator",
        value: report,
      });
      const retained = [evidence];
      if (config.background) {
        for (const stream of ["stdout", "stderr"]) {
          const log = await sandbox.exec("head", ["-c", "1048576", `/result/service.${stream}.log`], { timeoutMs: 5000, env: {} });
          retained.push(await context.evidence.putText({ evaluatorId: definition.id, mimeType: "text/plain", role: `service-${stream}`, producer: "evaluator", text: log.exitCode === 0 ? log.stdout : `Log capture failed: ${log.stderr}` }));
        }
      }
      return {
        ok: report.ok,
        summary: report.ok
          ? "Sealed evaluator inputs remained unchanged"
          : "Sealed evaluator inputs changed or could not be verified",
        assertions: [{
          id: `${definition.id}.input-integrity`,
          passed: report.ok,
          summary: "Evaluator input path set, byte lengths, and SHA-256 digests are unchanged",
          expected: true,
          observed: report.ok,
        }],
        evidence: retained,
        metadata: { inputIntegrity: report.ok },
      };
    });

    let isolation = ["--user", "--map-root-user", "--net", "--mount-proc"];
    let dropCapabilities: string[] = [];
    if (!config.network) {
      const probe = await sandbox.exec("unshare", ["--user", "--map-root-user", "--net", "--", "true"], { timeoutMs: Math.min(timeoutMs, 10_000), env: {} });
      if (probe.exitCode !== 0) {
        // Solari VMs can create a network namespace without a nested user namespace.
        isolation = ["--net", "--mount-proc"];
        // Do not let a root process re-enter the VM's original network namespace.
        dropCapabilities = ["setpriv", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", "--"];
        const fallback = await sandbox.exec("unshare", [...isolation, "--", ...dropCapabilities, "true"], { timeoutMs: Math.min(timeoutMs, 10_000), env: {} });
        if (fallback.exitCode !== 0) throw new Error("Required network isolation is unavailable; submission was not executed");
      }
      metadata.networkIsolation = isolation.includes("--user") ? "user-netns" : "netns";
    }
    const argv = config.network ? config.argv : ["unshare", ...isolation, "--", ...dropCapabilities, ...config.argv];
    if (config.background) {
      if (!config.publishPort) throw new Error("background commands require publishPort");
      await sandbox.start("sh", ["-c", 'exec "$@" > /result/service.stdout.log 2> /result/service.stderr.log', "agentbench-service", ...argv], { cwd: "/submission", env, timeoutMs });
      const preview = await sandbox.previewUrl(config.publishPort);
      const health = withPreviewPath(preview.url, config.healthPath ?? "/");
      await waitForHealthy(health, timeoutMs);
      return { status: "passed", earnedFraction: 1, summary: "Background service is healthy", assertions: [{ id: `${definition.id}.health`, passed: true, summary: "Preview health check" }], evidence: [], outputs: { previewUrl: preview.url }, metadata };
    }
    const result = await sandbox.exec(argv[0], argv.slice(1), { cwd: "/submission", timeoutMs, env });
    const evidence = await Promise.all([
      context.evidence.putText({ evaluatorId: definition.id, mimeType: "text/plain", role: "stdout", producer: "evaluator", text: result.stdout.slice(0, 1024 * 1024) }),
      context.evidence.putText({ evaluatorId: definition.id, mimeType: "text/plain", role: "stderr", producer: "evaluator", text: result.stderr.slice(0, 1024 * 1024) }),
    ]);
    let resultBytes: Uint8Array | undefined;
    try { resultBytes = await sandbox.readFile("/result/evaluator-result.json"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !/missing/i.test(error instanceof Error ? error.message : "")) throw error; }
    const parsed = resultBytes ? ResultFile.parse(JSON.parse(Buffer.from(resultBytes).toString("utf8"))) : undefined;
    const assertions = parsed?.assertions ?? [{ id: `${definition.id}.exit`, passed: result.exitCode === 0, summary: `Command exited with ${result.exitCode}`, expected: 0, observed: result.exitCode }];
    const passedCount = assertions.filter((item) => item.passed).length;
    const passed = result.exitCode === 0 && passedCount === assertions.length;
    let previewUrl: string | undefined;
    if (config.resultPreview) {
      await sandbox.start(
        "python3",
        ["-m", "http.server", String(config.resultPreview.port), "--directory", config.resultPreview.directory],
        { cwd: "/result", env: {}, timeoutMs },
      );
      const preview = await sandbox.previewUrl(config.resultPreview.port);
      await waitForHealthy(
        withPreviewPath(preview.url, config.resultPreview.healthPath),
        timeoutMs,
      );
      previewUrl = preview.url;
    }
    return { status: passed ? "passed" : "failed", earnedFraction: assertions.length ? passedCount / assertions.length : (passed ? 1 : 0), summary: passed ? "Command assertions passed" : "Command assertion failed", assertions, evidence, outputs: { ...(parsed?.outputs ?? {}), ...(previewUrl ? { previewUrl } : {}) }, metadata: { ...metadata, exitCode: result.exitCode, ...(previewUrl ? { resultPreview: true } : {}) } };
  }
}
