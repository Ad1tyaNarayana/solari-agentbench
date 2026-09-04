import { z } from "zod";
import type { EvaluatorDefinition } from "@/core/benchmarks/types";
import { resolveValue } from "./value-reference";
import type { Evaluator, EvaluatorContext, EvaluatorOutcome } from "./types";

export type Point = { x: number; y: number };
export type Ellipse = { centerX: number; centerY: number; radiusX: number; radiusY: number };
const Config = z.object({ operation: z.enum(["exact", "absolute-tolerance", "relative-tolerance", "mean", "sample-variance", "pearson-correlation", "ellipse-rmse", "reproducible-equality"]), actual: z.unknown(), expected: z.unknown(), other: z.unknown().optional(), tolerance: z.number().nonnegative().optional(), target: z.unknown().optional() }).strict();

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}
function numbers(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item) => finite(item, label));
}
export const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
export function sampleVariance(values: number[]): number { if (values.length < 2) throw new Error("Sample variance needs at least two values"); const average = mean(values); return values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1); }
export function pearsonCorrelation(xs: number[], ys: number[]): number { if (xs.length !== ys.length || xs.length < 2) throw new Error("Correlation arrays must have equal length of at least two"); const mx = mean(xs); const my = mean(ys); const numerator = xs.reduce((sum, x, index) => sum + (x - mx) * (ys[index] - my), 0); const denominator = Math.sqrt(xs.reduce((sum, x) => sum + (x - mx) ** 2, 0) * ys.reduce((sum, y) => sum + (y - my) ** 2, 0)); return denominator === 0 ? 0 : numerator / denominator; }
export function ellipseRmse(points: Point[], target: Ellipse): number { if (!points.length) throw new Error("Ellipse RMSE requires points"); const error = points.reduce((sum, point) => { const radial = Math.hypot((finite(point.x, "x") - finite(target.centerX, "centerX")) / finite(target.radiusX, "radiusX"), (finite(point.y, "y") - finite(target.centerY, "centerY")) / finite(target.radiusY, "radiusY")); return sum + Math.abs(radial - 1) ** 2; }, 0); return Math.sqrt(error / points.length); }

export class NumericEvaluator implements Evaluator {
  readonly type = "numeric" as const;
  validate(definition: EvaluatorDefinition): void { Config.parse(definition.config); }
  async evaluate(definition: EvaluatorDefinition, context: EvaluatorContext, _signal: AbortSignal): Promise<EvaluatorOutcome> {
    const config = Config.parse(definition.config);
    const actualInput = resolveValue(config.actual, context);
    const expectedInput = resolveValue(config.expected, context);
    const tolerance = config.tolerance ?? 0;
    let observed: unknown = actualInput;
    let passed: boolean;
    if (config.operation === "exact" || config.operation === "reproducible-equality") {
      if (typeof actualInput === "number") finite(actualInput, "actual");
      if (typeof expectedInput === "number") finite(expectedInput, "expected");
      passed = JSON.stringify(actualInput) === JSON.stringify(expectedInput);
    }
    else {
      const expected = finite(expectedInput, "expected");
      if (config.operation === "absolute-tolerance") observed = finite(actualInput, "actual");
      else if (config.operation === "relative-tolerance") observed = finite(actualInput, "actual");
      else if (config.operation === "mean") observed = mean(numbers(actualInput, "actual"));
      else if (config.operation === "sample-variance") observed = sampleVariance(numbers(actualInput, "actual"));
      else if (config.operation === "pearson-correlation") observed = pearsonCorrelation(numbers(actualInput, "actual"), numbers(resolveValue(config.other, context), "other"));
      else observed = ellipseRmse(actualInput as Point[], config.target as Ellipse);
      const delta = Math.abs(finite(observed, "observed") - expected);
      passed = config.operation === "relative-tolerance" ? delta <= tolerance * Math.max(Math.abs(expected), Number.EPSILON) : delta <= tolerance;
    }
    return { status: passed ? "passed" : "failed", earnedFraction: passed ? 1 : 0, summary: passed ? `${config.operation} matched` : `${config.operation} differed`, assertions: [{ id: `${definition.id}.${config.operation}`, passed, summary: config.operation, expected: expectedInput, observed }], evidence: [], outputs: { observed }, metadata: { tolerance } };
  }
}
