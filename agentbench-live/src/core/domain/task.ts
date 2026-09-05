import type { Primitive } from "./plan";
import type { EvaluationPolicy, EvaluatorDefinition } from "@/core/benchmarks/types";

export type ResourceBudget = {
  targetMs?: number;
  totalMs: number;
  browserMs: number;
  sandboxMs: number;
  desktopMs: number;
};

export type TaskManifest = {
  id: string;
  version: string;
  title: string;
  prompt: string;
  allowedPrimitives: Primitive[];
  requiredEvidence: Primitive[];
  budget: ResourceBudget;
  verifier?: string;
  evaluators?: EvaluatorDefinition[];
  evaluationPolicy?: EvaluationPolicy;
  snapshotPrefix?: string;
};
