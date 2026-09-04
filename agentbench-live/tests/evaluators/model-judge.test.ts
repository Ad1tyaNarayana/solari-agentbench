import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelJudgeEvaluator } from "@/core/evaluators/model-judge";
import type { EvaluatorContext } from "@/core/evaluators/types";

async function fixture(responses: string[]) {
  const root = await mkdtemp(join(tmpdir(), "agentbench-judge-"));
  await writeFile(join(root, "rubric.md"), "Score correctness.");
  const completeStructured = vi.fn(async (input: { prompt: string }) => { void input; return { text: responses.shift()!, resolvedModel: "judge-v1", usage: { inputTokens: 10, outputTokens: 5 } }; });
  const putText = vi.fn(async (input) => ({ ...input, digest: "a".repeat(64), size: 10, runId: "r", taskId: "t", createdAt: "now", redacted: true }));
  const putJson = vi.fn(async (input) => ({ ...input, digest: "b".repeat(64), size: 10, runId: "r", taskId: "t", createdAt: "now", redacted: true }));
  return { context: { runId: "r", taskId: "t", snapshot: { root, digest: "s", files: [{ path: "rubric.md", digest: "rubric-digest", size: 18 }] }, submission: { digest: "sub", entries: { "report.md": { kind: "text", contents: "finding" }, "secret.txt": { kind: "text", contents: "not selected" } } }, providers: { getStructuredCompletion: () => ({ completeStructured }) }, evidence: { putText, putJson } } as unknown as EvaluatorContext, completeStructured, putText };
}

const definition = { id: "judge", type: "model-judge" as const, weight: 100, enabled: true, prerequisites: [], config: { provider: "openai-compatible", model: "judge-v1", rubric: "rubric.md", inputs: ["report.md"], sampling: { temperature: 0 } } };

test("judges only declared inputs and preserves complete provenance", async () => {
  const { context, completeStructured, putText } = await fixture([JSON.stringify({ score: 0, summary: "Incorrect", criteria: [{ id: "correct", score: 0, rationale: "Mismatch" }] })]);
  const outcome = await new ModelJudgeEvaluator().evaluate(definition, context, new AbortController().signal);
  expect(outcome).toMatchObject({ status: "failed", earnedFraction: 0, metadata: { provider: "openai-compatible", resolvedModel: "judge-v1", retryCount: 0, rubricDigest: "rubric-digest" } });
  expect(completeStructured).toHaveBeenCalledOnce();
  expect(completeStructured.mock.calls[0]![0].prompt).toContain("finding");
  expect(completeStructured.mock.calls[0]![0].prompt).not.toContain("not selected");
  expect(putText).toHaveBeenCalled();
});

test("repairs invalid structured output once and errors after a second invalid result", async () => {
  const repaired = await fixture(["not json", JSON.stringify({ score: 1, summary: "Correct", criteria: [] })]);
  expect((await new ModelJudgeEvaluator().evaluate(definition, repaired.context, new AbortController().signal)).metadata.retryCount).toBe(1);
  expect(repaired.completeStructured).toHaveBeenCalledTimes(2);
  const broken = await fixture(["bad", "still bad"]);
  await expect(new ModelJudgeEvaluator().evaluate(definition, broken.context, new AbortController().signal)).rejects.toThrow(/invalid/i);
});
