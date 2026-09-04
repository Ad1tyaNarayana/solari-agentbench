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
  resources: { publishOutputs: vi.fn(), runFinalizers: vi.fn(async () => []) },
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

test("runs finalizers after the complete prerequisite graph", async () => {
  const order: string[] = [];
  const callbacks: Array<{
    evaluatorId: string;
    callback: () => Promise<{ ok: boolean; summary: string; assertions: never[]; evidence: never[]; metadata: Record<string, unknown> }>;
  }> = [];
  const resources = {
    publishOutputs: vi.fn(),
    registerFinalizer: (evaluatorId: string, callback: (typeof callbacks)[number]["callback"]) => callbacks.push({ evaluatorId, callback }),
    runFinalizers: async () => Promise.all(callbacks.map(async ({ evaluatorId, callback }) => ({ evaluatorId, ...(await callback()) }))),
  };
  const finalizerContext = { ...context, resources } as unknown as EvaluatorContext;
  const registry = new EvaluatorRegistry();
  registry.register("file", evaluator("file", async (_definition, evaluatorContext) => {
    order.push("command");
    evaluatorContext.resources.registerFinalizer("command", async () => {
      order.push("finalize");
      return { ok: true, summary: "inputs intact", assertions: [], evidence: [], metadata: {} };
    });
    return { status: "passed", earnedFraction: 1, summary: "command", assertions: [], evidence: [], outputs: {}, metadata: {} };
  }));
  registry.register("browser", evaluator("browser", async () => {
    order.push("browser");
    return { status: "passed", earnedFraction: 1, summary: "browser", assertions: [], evidence: [], outputs: {}, metadata: {} };
  }));

  await new EvaluatorPipeline(registry).run(finalizerContext, [
    definition("command", "file", 50),
    definition("browser", "browser", 50, ["command"]),
  ]);

  expect(order).toEqual(["command", "browser", "finalize"]);
});

test("turns an integrity finalizer failure into an invalid score", async () => {
  const registry = new EvaluatorRegistry();
  registry.register("command", evaluator("command", async () => ({
    status: "passed",
    earnedFraction: 1,
    summary: "command passed",
    assertions: [],
    evidence: [],
    outputs: {},
    metadata: {},
  })));
  const integrityEvidence = {
    digest: "a".repeat(64),
    size: 12,
    mimeType: "application/json",
    role: "input-integrity",
    producer: "evaluator" as const,
    runId: "run-1",
    taskId: "task-1",
    evaluatorId: "command",
    createdAt: "2026-09-04T00:00:00.000Z",
    redacted: true,
  };
  const failureContext = {
    ...context,
    resources: {
      publishOutputs: vi.fn(),
      runFinalizers: vi.fn(async () => [{
        evaluatorId: "command",
        ok: false,
        summary: "sealed evaluator inputs changed",
        assertions: [{ id: "command.input-integrity", passed: false, summary: "Input trees are unchanged" }],
        evidence: [integrityEvidence],
        metadata: { inputIntegrity: false },
      }]),
    },
  } as unknown as EvaluatorContext;

  const report = await new EvaluatorPipeline(registry).run(
    failureContext,
    [definition("command", "command", 100)],
  );

  expect(report).toMatchObject({ status: "invalid-score", score: null });
  expect(report.results[0]).toMatchObject({
    evaluatorId: "command",
    status: "error",
    earnedPoints: 0,
    summary: "sealed evaluator inputs changed",
    evidence: [integrityEvidence],
  });
});
