import type { EvaluatorDefinition } from "@/core/benchmarks/types";
import { redact } from "@/core/security/redact";
import { scoreEvaluation } from "@/core/runner/scoring";
import { EvaluatorConfigurationError } from "./errors";
import type { EvaluationReport, EvaluatorContext, EvaluatorResult } from "./types";
import type { EvaluatorRegistry } from "./registry";

function validateGraph(definitions: EvaluatorDefinition[]): void {
  const ids = new Set<string>();
  for (const definition of definitions) {
    if (ids.has(definition.id)) throw new EvaluatorConfigurationError(`Duplicate evaluator id: ${definition.id}`);
    ids.add(definition.id);
  }
  for (const definition of definitions) {
    for (const prerequisite of definition.prerequisites) {
      if (!ids.has(prerequisite)) throw new EvaluatorConfigurationError(`Missing prerequisite ${prerequisite} for ${definition.id}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(definitions.map((item) => [item.id, item]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new EvaluatorConfigurationError(`Evaluator prerequisite cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.prerequisites ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const definition of definitions) visit(definition.id);
}

export class EvaluatorPipeline {
  constructor(private readonly registry: EvaluatorRegistry) {}

  async run(context: EvaluatorContext, definitions: EvaluatorDefinition[], signal: AbortSignal = new AbortController().signal): Promise<EvaluationReport> {
    const enabled = definitions.filter((item) => item.enabled);
    validateGraph(enabled);
    for (const definition of enabled) this.registry.get(definition.type).validate(definition);

    const results = new Map<string, EvaluatorResult>();
    while (results.size < enabled.length) {
      const definition = enabled.find((item) => !results.has(item.id) && item.prerequisites.every((id) => results.has(id)));
      if (!definition) throw new EvaluatorConfigurationError("Evaluator graph could not be scheduled");
      const blockedBy = definition.prerequisites.find((id) => results.get(id)?.status !== "passed");
      if (blockedBy) {
        results.set(definition.id, {
          evaluatorId: definition.id, status: "skipped", earnedPoints: 0, possiblePoints: definition.weight,
          summary: `Skipped because prerequisite ${blockedBy} did not pass`, assertions: [], evidence: [], outputs: {},
          metadata: { reason: "prerequisite", prerequisite: blockedBy },
        });
        continue;
      }
      try {
        const outcome = await this.registry.get(definition.type).evaluate(definition, context, signal);
        const earnedFraction = Math.min(1, Math.max(0, outcome.earnedFraction));
        const result: EvaluatorResult = { ...outcome, evaluatorId: definition.id, earnedPoints: earnedFraction * definition.weight, possiblePoints: definition.weight };
        results.set(definition.id, result);
        context.resources.publishOutputs(definition.id, result.outputs);
      } catch (error) {
        results.set(definition.id, {
          evaluatorId: definition.id, status: "error", earnedPoints: 0, possiblePoints: definition.weight,
          summary: redact(error instanceof Error ? error.message : String(error)), assertions: [], evidence: [], outputs: {}, metadata: {},
        });
      }
    }
    const ordered = enabled.map((item) => results.get(item.id)!);
    return { ...scoreEvaluation(ordered, enabled.length), results: ordered };
  }
}
