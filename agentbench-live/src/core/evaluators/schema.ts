import { z } from "zod";
import { parse as parseYaml } from "yaml";
import type { EvaluatorDefinition } from "@/core/benchmarks/types";
import { compileSnapshotSchema } from "./json-schema";
import type { Evaluator, EvaluatorContext, EvaluatorOutcome } from "./types";

const Config = z.object({ subject: z.string().min(1), schema: z.string().min(1) }).strict();

export class SchemaEvaluator implements Evaluator {
  readonly type = "schema" as const;
  validate(definition: EvaluatorDefinition): void { Config.parse(definition.config); }
  async evaluate(definition: EvaluatorDefinition, context: EvaluatorContext, signal: AbortSignal): Promise<EvaluatorOutcome> {
    void signal;
    const config = Config.parse(definition.config);
    const entry = context.submission.entries[config.subject];
    if (!entry || entry.kind !== "text") throw new Error(`Schema subject is not a text file: ${config.subject}`);
    const value = /\.ya?ml$/i.test(config.subject) ? parseYaml(entry.contents) : JSON.parse(entry.contents);
    const validate = await compileSnapshotSchema(context.snapshot, config.schema);
    const passed = Boolean(validate(value));
    const assertions = passed ? [{ id: `${definition.id}.schema`, passed: true, summary: "Document matches schema" }] :
      (validate.errors ?? []).map((error, index) => ({ id: `${definition.id}.schema.${index + 1}`, passed: false, summary: `${error.instancePath || "/"} ${error.message ?? error.keyword}`, expected: error.params }));
    return { status: passed ? "passed" : "failed", earnedFraction: passed ? 1 : 0, summary: passed ? "Schema valid" : `${assertions.length} schema violation(s)`, assertions, evidence: [], outputs: {}, metadata: { schema: config.schema } };
  }
}
