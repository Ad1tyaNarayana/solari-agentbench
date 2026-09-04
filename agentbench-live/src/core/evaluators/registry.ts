import type { EvaluatorType } from "@/core/benchmarks/types";
import { EvaluatorConfigurationError } from "./errors";
import type { Evaluator } from "./types";

export class EvaluatorRegistry {
  private readonly evaluators = new Map<EvaluatorType, Evaluator>();

  register(type: EvaluatorType, evaluator: Evaluator): void {
    if (evaluator.type !== type) throw new EvaluatorConfigurationError(`Evaluator type mismatch: ${type}`);
    if (this.evaluators.has(type)) throw new EvaluatorConfigurationError(`Evaluator already registered: ${type}`);
    this.evaluators.set(type, evaluator);
  }

  get(type: EvaluatorType): Evaluator {
    const evaluator = this.evaluators.get(type);
    if (!evaluator) throw new EvaluatorConfigurationError(`Unknown evaluator type: ${type}`);
    return evaluator;
  }
}
