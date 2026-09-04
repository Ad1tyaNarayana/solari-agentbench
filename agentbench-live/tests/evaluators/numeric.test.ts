import { NumericEvaluator, ellipseRmse, sampleVariance } from "@/core/evaluators/numeric";
import type { EvaluatorContext } from "@/core/evaluators/types";

const context = {
  submission: { digest: "x", entries: { "values.json": { kind: "text", contents: JSON.stringify({ value: 10.05, xs: [1, 2, 3], ys: [2, 4, 6] }) } } },
  resources: { getOutput: (id: string, key: string) => id === "run" && key === "value" ? 10 : undefined },
} as unknown as EvaluatorContext;
const run = (config: Record<string, unknown>) => new NumericEvaluator().evaluate({ id: "n", type: "numeric", weight: 100, enabled: true, prerequisites: [], config }, context, new AbortController().signal);

test("supports exact, tolerances, statistics, correlations, and output references", async () => {
  expect((await run({ operation: "absolute-tolerance", actual: { file: "values.json", pointer: "/value" }, expected: { fromEvaluator: "run", output: "value" }, tolerance: 0.1 })).status).toBe("passed");
  expect((await run({ operation: "relative-tolerance", actual: 10.05, expected: 10, tolerance: 0.01 })).status).toBe("passed");
  expect((await run({ operation: "mean", actual: { file: "values.json", pointer: "/xs" }, expected: 2, tolerance: 0 })).status).toBe("passed");
  expect((await run({ operation: "pearson-correlation", actual: { file: "values.json", pointer: "/xs" }, other: { file: "values.json", pointer: "/ys" }, expected: 1, tolerance: 0 })).status).toBe("passed");
  expect(sampleVariance([1, 2, 3])).toBe(1);
  expect(ellipseRmse([{ x: 1, y: 0 }], { centerX: 0, centerY: 0, radiusX: 1, radiusY: 1 })).toBe(0);
});

test("rejects non-finite operands and reports finite mismatches as failures", async () => {
  await expect(run({ operation: "exact", actual: Number.NaN, expected: 1 })).rejects.toThrow(/finite/i);
  const outcome = await run({ operation: "exact", actual: 2, expected: 1 });
  expect(outcome).toMatchObject({ status: "failed", assertions: [{ passed: false, expected: 1, observed: 2 }] });
});
