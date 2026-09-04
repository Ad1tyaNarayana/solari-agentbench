import { HttpEvaluator } from "@/core/evaluators/http";
import type { EvaluatorContext } from "@/core/evaluators/types";

const context = { resources: { getOutput: () => "https://preview.test/api" } } as unknown as EvaluatorContext;

test("resolves verifier-owned URLs and evaluates status, headers, JSON, and text", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 201, headers: { "x-test": "yes", "content-type": "application/json" } }));
  const outcome = await new HttpEvaluator(fetcher).evaluate({ id: "http", type: "http", weight: 100, enabled: true, prerequisites: ["serve"], config: {
    url: { fromEvaluator: "serve", output: "previewUrl" }, method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    assertions: [{ type: "status", equals: 201 }, { type: "header", name: "x-test", equals: "yes" }, { type: "json", pointer: "/ok", equals: true }, { type: "text", contains: "true" }],
  } }, context, new AbortController().signal);
  expect(fetcher).toHaveBeenCalledWith("https://preview.test/api", expect.objectContaining({ method: "POST", redirect: "error" }));
  expect(outcome).toMatchObject({ status: "passed", earnedFraction: 1 });
  expect(outcome.assertions).toHaveLength(4);
});

test("rejects credential headers and classifies network failures as evaluator errors", async () => {
  const evaluator = new HttpEvaluator(async () => { throw new Error("network down"); });
  const assertions = [{ type: "status", equals: 200 }];
  await expect(evaluator.evaluate({ id: "h", type: "http", weight: 100, enabled: true, prerequisites: [], config: { url: "https://example.test", headers: { authorization: "Bearer nope" }, assertions } }, context, new AbortController().signal)).rejects.toThrow(/header/i);
  await expect(evaluator.evaluate({ id: "h", type: "http", weight: 100, enabled: true, prerequisites: [], config: { url: "https://example.test", assertions } }, context, new AbortController().signal)).rejects.toThrow(/network down/i);
});
