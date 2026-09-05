import { createHash } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import type { EvaluatorDefinition } from "@/core/benchmarks/types";
import type { Evaluator, EvaluatorContext, EvaluatorOutcome } from "./types";

const Config = z.object({
  subject: z.string().min(1),
  assertion: z.enum(["present", "absent", "min-bytes", "max-bytes", "sha256", "contains", "regex"]),
  value: z.union([z.string(), z.number().nonnegative()]).optional(),
  flags: z.string().regex(/^[ims]*$/, "Only regex flags i, m, and s are allowed").optional(),
}).strict();

function normalize(path: string): string {
  const value = path.replaceAll("\\", "/");
  if (value.startsWith("/") || /^[A-Za-z]:\//.test(value) || value.split("/").includes("..")) throw new Error("File path escapes submission");
  return posix.normalize(value);
}

export class FileEvaluator implements Evaluator {
  readonly type = "file" as const;
  validate(definition: EvaluatorDefinition): void {
    const config = Config.parse(definition.config);
    if (config.assertion === "regex") new RegExp(String(config.value), config.flags);
  }

  async evaluate(definition: EvaluatorDefinition, context: EvaluatorContext, signal: AbortSignal): Promise<EvaluatorOutcome> {
    void signal;
    const config = Config.parse(definition.config);
    const entry = context.submission.entries[normalize(config.subject)];
    const bytes = entry ? (entry.kind === "text" ? Buffer.from(entry.contents) : Buffer.from(entry.contents)) : undefined;
    let passed = false;
    let observed: unknown = entry ? bytes!.length : "missing";
    if (config.assertion === "present") passed = Boolean(entry);
    else if (config.assertion === "absent") passed = !entry;
    else {
      if (!entry || !bytes) passed = false;
      else if (config.assertion === "min-bytes") passed = bytes.length >= Number(config.value);
      else if (config.assertion === "max-bytes") passed = bytes.length <= Number(config.value);
      else if (config.assertion === "sha256") { observed = createHash("sha256").update(bytes).digest("hex"); passed = observed === config.value; }
      else {
        if (entry.kind !== "text" || bytes.length > 1024 * 1024) throw new Error("Text assertions require a UTF-8 text file no larger than 1 MiB");
        observed = entry.contents;
        if (config.assertion === "contains") passed = entry.contents.includes(String(config.value));
        else passed = new RegExp(String(config.value), config.flags).test(entry.contents);
      }
    }
    return {
      status: passed ? "passed" : "failed", earnedFraction: passed ? 1 : 0,
      summary: passed ? `${config.subject} satisfied ${config.assertion}` : `${config.subject} did not satisfy ${config.assertion}`,
      assertions: [{ id: `${definition.id}.${config.assertion}`, passed, summary: `${config.assertion} ${config.subject}`, expected: config.value ?? config.assertion, observed }],
      evidence: [], outputs: {}, metadata: {},
    };
  }
}
