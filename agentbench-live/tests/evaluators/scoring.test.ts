import { scoreEvaluation } from "@/core/runner/scoring";
import type { EvaluatorResult } from "@/core/evaluators/types";

function result(id: string, status: EvaluatorResult["status"], earned: number, possible: number): EvaluatorResult {
  return { evaluatorId: id, status, earnedPoints: earned, possiblePoints: possible, summary: id, assertions: [], evidence: [], outputs: {}, metadata: {} };
}

test("preserves partial weighted points and rounds only the displayed score", () => {
  expect(scoreEvaluation([result("a", "passed", 10 / 3, 10), result("b", "failed", 20, 90)], 2)).toEqual({ status: "valid-score", score: 23.33, possiblePoints: 100 });
});

test("errors, missing weight, and totals other than 100 invalidate scoring", () => {
  expect(scoreEvaluation([result("a", "error", 0, 100)], 1).score).toBeNull();
  expect(scoreEvaluation([result("a", "passed", 90, 90)], 1).score).toBeNull();
  expect(scoreEvaluation([result("a", "passed", 100, 100)], 2).score).toBeNull();
});
