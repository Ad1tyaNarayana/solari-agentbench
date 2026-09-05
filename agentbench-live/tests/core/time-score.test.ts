import { timeAdjustedScore } from "@/core/domain/time-score";

test.each([[0, 100], [299999, 100], [300000, 100], [600000, 50], [900000, 33.33]])("scores 100 quality at %i ms as %f", (elapsed, expected) => {
  expect(timeAdjustedScore(100, elapsed, 300000)).toBe(expected);
});
test("does not change historical runs without an explicit time target", () => {
  expect(timeAdjustedScore(100, 600000, undefined)).toBeUndefined();
});
test.each([null, undefined, NaN])("does not create a score from an invalid evaluator result %s", score => {
  expect(timeAdjustedScore(score, 600000, 300000)).toBeUndefined();
});
