export type ScoreOutcome = {
  core: number;
  reproducible: boolean;
  methodology: number;
  evidence: number;
  withinBudget: boolean;
};

export type ScoreBreakdown = {
  core: number;
  reproducible: number;
  methodology: number;
  evidence: number;
  budget: number;
  total: number;
};

import type { EvaluationReport, EvaluatorResult } from "@/core/evaluators/types";

export function scoreEvaluation(
  results: EvaluatorResult[],
  expectedResultCount: number,
): Omit<EvaluationReport, "results"> {
  const possiblePoints = results.reduce((sum, item) => sum + item.possiblePoints, 0);
  const valid = results.length === expectedResultCount && possiblePoints === 100 &&
    results.every((item) => item.status !== "error");
  const earned = results.reduce((sum, item) => sum + item.earnedPoints, 0);
  return {
    status: valid ? "valid-score" : "invalid-score",
    score: valid ? Math.round(earned * 100) / 100 : null,
    possiblePoints: 100,
  };
}

function category(value: number, maximum: number): number {
  return Math.min(maximum, Math.max(0, value));
}

export function computeScore(outcome: ScoreOutcome): ScoreBreakdown {
  if (!outcome.reproducible) {
    return {
      core: 0,
      reproducible: 0,
      methodology: 0,
      evidence: 0,
      budget: 0,
      total: 0,
    };
  }

  const score = {
    core: category(outcome.core, 45),
    reproducible: 20,
    methodology: category(outcome.methodology, 15),
    evidence: category(outcome.evidence, 15),
    budget: outcome.withinBudget ? 5 : 0,
  };

  return { ...score, total: Object.values(score).reduce((sum, item) => sum + item, 0) };
}

export function applyBudgetOutcome(
  score: ScoreBreakdown,
  withinBudget: boolean,
): ScoreBreakdown {
  const budget = withinBudget && score.reproducible > 0 ? 5 : 0;
  return {
    ...score,
    budget,
    total: score.total - score.budget + budget,
  };
}
