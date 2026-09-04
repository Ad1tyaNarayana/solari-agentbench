import { EvaluatorPipeline } from "@/core/evaluators/pipeline";
import { EvaluatorRegistry } from "@/core/evaluators/registry";
import type { Evaluator, EvaluatorContext } from "@/core/evaluators/types";
import type { EvaluatorDefinition, EvaluatorType } from "@/core/benchmarks/types";

function evaluator(type: EvaluatorType, run: Evaluator["evaluate"]): Evaluator {
  return { type, validate() {}, evaluate: run };
}

function definition(id: string, type: EvaluatorType, weight: number, prerequisites: string[] = []): EvaluatorDefinition {
  return { id, type, weight, enabled: true, prerequisites, config: {} };
}

const context = {
  runId: "run-1",
  taskId: "task-1",
  resources: { publishOutputs: vi.fn() },
} as unknown as EvaluatorContext;

test("runs ready evaluators in stable declaration order and skips failed dependents", async () => {
  const order: string[] = [];
  const registry = new EvaluatorRegistry();
  registry.register("file", evaluator("file", async (d) => {
    order.push(d.id);
    return { status: d.id === "a" ? "failed" : "passed", earnedFraction: d.id === "a" ? 0 : 1, summary: d.id, assertions: [], evidence: [], outputs: {}, metadata: {} };
  }));
  const report = await new EvaluatorPipeline(registry).run(context, [
    definition("a", "file", 30),
    definition("dependent", "file", 30, ["a"]),
    definition("independent", "file", 40),
  ]);

  expect(order).toEqual(["a", "independent"]);
  expect(report).toMatchObject({ status: "valid-score", score: 40, possiblePoints: 100 });
  expect(report.results[1]).toMatchObject({ evaluatorId: "dependent", status: "skipped", earnedPoints: 0, metadata: { reason: "prerequisite", prerequisite: "a" } });
});

test("converts evaluator throws to errors and invalidates the primary score", async () => {
  const registry = new EvaluatorRegistry();
  registry.register("schema", evaluator("schema", async () => { throw new Error("compiler exploded"); }));
  const report = await new EvaluatorPipeline(registry).run(context, [definition("schema", "schema", 100)]);
  expect(report).toMatchObject({ status: "invalid-score", score: null, possiblePoints: 100, results: [{ evaluatorId: "schema", status: "error", summary: "compiler exploded" }] });
});

test.each([
  [[definition("same", "file", 50), definition("same", "file", 50)], /duplicate/i],
  [[definition("a", "file", 100, ["missing"])], /missing/i],
  [[definition("a", "file", 50, ["b"]), definition("b", "file", 50, ["a"])], /cycle/i],
] as const)("rejects invalid evaluator graphs", async (definitions, message) => {
  const registry = new EvaluatorRegistry();
  registry.register("file", evaluator("file", async () => ({ status: "passed", earnedFraction: 1, summary: "ok", assertions: [], evidence: [], outputs: {}, metadata: {} })));
  await expect(new EvaluatorPipeline(registry).run(context, [...definitions])).rejects.toThrow(message);
});

test("rejects duplicate registrations and unknown evaluator types", () => {
  const registry = new EvaluatorRegistry();
  const implementation = evaluator("file", async () => ({ status: "passed", earnedFraction: 1, summary: "ok", assertions: [], evidence: [], outputs: {}, metadata: {} }));
  registry.register("file", implementation);
  expect(() => registry.register("file", implementation)).toThrow(/already registered/i);
  expect(() => registry.get("browser")).toThrow(/unknown evaluator/i);
});
