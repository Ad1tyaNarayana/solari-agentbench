import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { z } from "zod";
import type { EvaluatorDefinition } from "@/core/benchmarks/types";
import type { AgentDefinition } from "@/core/benchmarks/types";
import { JudgeOutputSchema, judgeOutputJsonSchema } from "./judge-schema";
import type { Evaluator, EvaluatorContext, EvaluatorOutcome } from "./types";

const Config = z.object({ provider: z.string().min(1), model: z.string().min(1).optional(), credential: z.string().min(1).optional(), rubric: z.string().min(1), inputs: z.array(z.string().min(1)).max(100), sampling: z.record(z.string(), z.unknown()).default({}) }).strict();
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function safe(path: string): string { const normalized = path.replaceAll("\\", "/"); if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) throw new Error(`Unsafe judge input path: ${path}`); return posix.normalize(normalized); }

export class ModelJudgeEvaluator implements Evaluator {
  readonly type = "model-judge" as const;
  validate(definition: EvaluatorDefinition): void { Config.parse(definition.config); }
  async evaluate(definition: EvaluatorDefinition, context: EvaluatorContext, signal: AbortSignal): Promise<EvaluatorOutcome> {
    const config = Config.parse(definition.config);
    const rubricPath = safe(config.rubric);
    const rubricFile = context.snapshot.files.find((file) => file.path === rubricPath);
    if (!rubricFile) throw new Error(`Judge rubric is not in benchmark snapshot: ${rubricPath}`);
    const rubric = await readFile(join(context.snapshot.root, ...rubricPath.split("/")), "utf8");
    const selected = config.inputs.map((rawPath) => {
      const path = safe(rawPath); const entry = context.submission.entries[path];
      if (!entry) throw new Error(`Declared judge input is missing: ${path}`);
      const bytes = entry.kind === "text" ? Buffer.from(entry.contents) : Buffer.from(entry.contents);
      return { path, digest: digest(bytes), contents: entry.kind === "text" ? entry.contents : `[binary ${entry.mediaType}; sha256:${digest(bytes)}]` };
    });
    const prompt = [
      `Benchmark task: ${context.taskId}`, `Rubric SHA-256: ${rubricFile.digest}`, "<rubric>", rubric, "</rubric>",
      ...selected.flatMap((input) => [`<submission path="${input.path}" sha256="${input.digest}">`, input.contents, "</submission>"]),
      "Return only JSON matching the supplied schema.",
    ].join("\n");
    const provider = context.providers.getStructuredCompletion(config.provider);
    const agent: AgentDefinition = { id: `judge-${definition.id}`, name: `Judge ${definition.id}`, provider: config.provider, ...(config.model ? { model: config.model } : {}), ...(config.credential ? { credential: config.credential } : {}), harness: { id: "model-judge", version: "1" }, options: { ...config.sampling } };
    const invoke = (requestPrompt: string) => provider.completeStructured({ agent, system: "You are an isolated benchmark judge. You have no tools. Apply only the immutable rubric.", prompt: requestPrompt, outputSchema: judgeOutputJsonSchema as unknown as Record<string, unknown>, workingDirectory: context.snapshot.root }, signal);
    const responses = [];
    let response = await invoke(prompt); responses.push(response);
    let parsed: z.infer<typeof JudgeOutputSchema> | undefined;
    let diagnostic = "";
    try { parsed = JudgeOutputSchema.parse(JSON.parse(response.text)); } catch (error) { diagnostic = error instanceof Error ? error.message : String(error); }
    if (!parsed) {
      response = await invoke(`${prompt}\n\nYour previous response was invalid:\n${response.text}\n\nValidation diagnostics:\n${diagnostic}\nReturn corrected JSON only.`); responses.push(response);
      try { parsed = JudgeOutputSchema.parse(JSON.parse(response.text)); } catch (error) { throw new Error(`Model judge returned invalid structured output after repair: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const rawEvidence = await Promise.all(responses.map((item, index) => context.evidence.putText({ evaluatorId: definition.id, mimeType: "application/json", role: `judge-response-${index + 1}`, producer: "evaluator", text: item.text })));
    const parsedEvidence = await context.evidence.putJson({ evaluatorId: definition.id, mimeType: "application/json", role: "judge-result", producer: "evaluator", value: parsed });
    const assertions = parsed.criteria.length ? parsed.criteria.map((criterion) => ({ id: criterion.id, passed: criterion.score === 1, summary: criterion.rationale, expected: 1, observed: criterion.score })) : [{ id: `${definition.id}.score`, passed: parsed.score === 1, summary: parsed.summary, expected: 1, observed: parsed.score }];
    return {
      status: parsed.score === 1 ? "passed" : "failed", earnedFraction: parsed.score, summary: parsed.summary, assertions,
      evidence: [...rawEvidence, parsedEvidence], outputs: { score: parsed.score, criteria: parsed.criteria },
      metadata: { provider: config.provider, resolvedModel: response.resolvedModel ?? config.model, sampling: config.sampling, rubricDigest: rubricFile.digest, promptDigest: digest(prompt), selectedInputDigests: Object.fromEntries(selected.map((item) => [item.path, item.digest])), usage: response.usage, retryCount: responses.length - 1 },
    };
  }
}
