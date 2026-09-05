import { createHash } from "node:crypto";
import { FileEvaluator } from "@/core/evaluators/file";
import type { EvaluatorContext } from "@/core/evaluators/types";

const context = { submission: { digest: "x", entries: { "report.txt": { kind: "text", contents: "AgentBench ships safely" } } } } as unknown as EvaluatorContext;
const run = (config: Record<string, unknown>) => new FileEvaluator().evaluate({ id: "file", type: "file", weight: 100, enabled: true, prerequisites: [], config }, context, new AbortController().signal);

test.each([
  [{ subject: "report.txt", assertion: "present" }, true],
  [{ subject: "missing.txt", assertion: "absent" }, true],
  [{ subject: "report.txt", assertion: "contains", value: "ships" }, true],
  [{ subject: "report.txt", assertion: "regex", value: "agentbench", flags: "i" }, true],
  [{ subject: "report.txt", assertion: "sha256", value: createHash("sha256").update("AgentBench ships safely").digest("hex") }, true],
  [{ subject: "report.txt", assertion: "max-bytes", value: 5 }, false],
] as const)("evaluates file assertion %#", async (config, passed) => {
  expect((await run(config)).assertions[0].passed).toBe(passed);
});

test("rejects traversal and unsafe regex flags", async () => {
  await expect(run({ subject: "../secret", assertion: "present" })).rejects.toThrow(/path/i);
  await expect(run({ subject: "report.txt", assertion: "regex", value: ".", flags: "g" })).rejects.toThrow(/flags/i);
});

test("rejects malformed regular expressions during evaluator validation", () => {
  expect(() => new FileEvaluator().validate({ id: "f", type: "file", weight: 1, enabled: true, prerequisites: [], config: { subject: "methodology.md", assertion: "regex", value: "(?m)^# Seed$", flags: "m" } })).toThrow(/regular expression/i);
});
