import { z } from "zod";
import type { EvaluatorDefinition } from "@/core/benchmarks/types";
import { uploadSnapshotTree, uploadTextTree } from "@/core/solari/upload-tree";
import type { Evaluator, EvaluatorContext, EvaluatorOutcome } from "./types";

const Config = z.object({
  argv: z.array(z.string()).min(1).max(256), network: z.boolean().default(false), timeoutMs: z.number().int().positive().max(3_600_000).optional(),
  background: z.boolean().default(false), publishPort: z.number().int().min(1).max(65535).optional(), healthPath: z.string().startsWith("/").optional(),
}).strict();
const ResultFile = z.object({
  assertions: z.array(z.object({ id: z.string(), passed: z.boolean(), summary: z.string(), expected: z.unknown().optional(), observed: z.unknown().optional() }).strict()).max(1_000),
  outputs: z.record(z.string(), z.unknown()).default({}), evidence: z.array(z.object({ path: z.string(), role: z.string(), mimeType: z.string() }).strict()).default([]),
}).strict();

export class CommandEvaluator implements Evaluator {
  readonly type = "command" as const;
  validate(definition: EvaluatorDefinition): void { Config.parse(definition.config); }
  async evaluate(definition: EvaluatorDefinition, context: EvaluatorContext, signal: AbortSignal): Promise<EvaluatorOutcome> {
    void signal;
    const config = Config.parse(definition.config);
    const timeoutMs = Math.max(1, Math.min(config.timeoutMs ?? context.remainingMs(), context.remainingMs()));
    const sandbox = await context.resources.acquireSandbox(`evaluator:${definition.id}`, { timeoutMs });
    await Promise.all([uploadTextTree(sandbox, context.submission, "/submission"), uploadSnapshotTree(sandbox, context.snapshot)]);
    await sandbox.mkdir("/result");
    const env = { AGENTBENCH_RESULT: "/result/evaluator-result.json" };
    const metadata: Record<string, unknown> = { networkEnabled: config.network };

    if (!config.network) {
      const probe = await sandbox.exec("unshare", ["--user", "--map-root-user", "--net", "--", "true"], { timeoutMs: Math.min(timeoutMs, 10_000), env: {} });
      if (probe.exitCode !== 0) throw new Error("Required network isolation is unavailable; submission was not executed");
    }
    const argv = config.network ? config.argv : ["unshare", "--user", "--map-root-user", "--net", "--mount-proc", "--", ...config.argv];
    if (config.background) {
      if (!config.publishPort) throw new Error("background commands require publishPort");
      await sandbox.start(argv[0], argv.slice(1), { cwd: "/submission", env, timeoutMs });
      const preview = await sandbox.previewUrl(config.publishPort);
      const health = new URL(config.healthPath ?? "/", preview.url).toString();
      const healthDeadline = Date.now() + Math.min(timeoutMs, 30_000);
      let healthy = false; let lastStatus = "unreachable";
      while (Date.now() < healthDeadline) {
        try { const response = await fetch(health, { signal: AbortSignal.timeout(Math.min(2_000, Math.max(1, healthDeadline - Date.now()))) }); lastStatus = String(response.status); if (response.ok) { healthy = true; break; } } catch (error) { lastStatus = error instanceof Error ? error.message : "unreachable"; }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!healthy) throw new Error(`Preview health check failed: ${lastStatus}`);
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
    return { status: passed ? "passed" : "failed", earnedFraction: assertions.length ? passedCount / assertions.length : (passed ? 1 : 0), summary: passed ? "Command assertions passed" : "Command assertion failed", assertions, evidence, outputs: parsed?.outputs ?? {}, metadata: { ...metadata, exitCode: result.exitCode } };
  }
}
