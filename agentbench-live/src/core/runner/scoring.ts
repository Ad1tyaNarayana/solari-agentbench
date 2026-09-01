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
