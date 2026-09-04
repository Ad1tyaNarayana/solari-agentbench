import { renderBenchmark } from "@/core/authoring/render";
import type { BenchmarkDraft } from "@/core/authoring/types";

export const draft: BenchmarkDraft = { schemaVersion: 1, id: "demo-bench", name: "Demo Bench", version: "1.0.0", description: "A custom benchmark", defaults: { timeoutSeconds: 300, maxConcurrency: 1, submissionDirectory: "submission" }, tasks: [{ id: "task-one", name: "Task One", prompt: "Build it.", fixtures: [], allowedPrimitives: ["sandbox"], planningRequired: true, resourceLimits: { browserSessions: 0, sandboxes: 1, desktops: 0, totalMinutes: 5 }, submission: { directory: "submission", required: ["result.json"] }, evaluators: [{ id: "result", type: "file", weight: 100, enabled: true, prerequisites: [], config: { subject: "result.json", assertion: "present" } }] }], agents: [{ id: "codex", name: "Codex", provider: "codex", model: "gpt-5.6-sol", harness: { id: "agentbench-basic-loop", version: "1" }, options: {} }] };

test("renders deterministic canonical files with stable final newlines", () => {
  const first = renderBenchmark(draft);
  expect(renderBenchmark(draft)).toEqual(first);
  expect(first.map((file) => file.path)).toEqual(["agents.yaml", "benchmark.yaml", "tasks/task-one/prompt.md", "tasks/task-one/task.yaml"]);
  expect(first.every((file) => file.contents.endsWith("\n") && !file.contents.endsWith("\n\n"))).toBe(true);
  expect(first.find((file) => file.path.endsWith("task.yaml"))?.contents).toContain("weight: 100");
});

test("renders editable rubric text as a separate immutable asset", () => {
  const judged = structuredClone(draft); judged.tasks[0].evaluationPolicy = { maxModelJudgeWeight: 100, allowModelJudgeMajority: true }; judged.tasks[0].evaluators = [{ id: "judge", type: "model-judge", weight: 100, enabled: true, prerequisites: [], config: { provider: "codex", rubric: "rubric.md", rubricText: "Judge correctness.", inputs: ["result.json"], sampling: {} } }];
  const files = renderBenchmark(judged);
  expect(files.find((file) => file.path === "tasks/task-one/rubric.md")?.contents).toBe("Judge correctness.\n");
  expect(files.find((file) => file.path.endsWith("task.yaml"))?.contents).not.toContain("rubricText");
});

test("renders an explicit model-judge authority policy as canonical task data", () => {
  const judged = structuredClone(draft);
  judged.tasks[0].evaluationPolicy = {
    maxModelJudgeWeight: 100,
    allowModelJudgeMajority: true,
  };
  judged.tasks[0].evaluators = [{
    id: "judge",
    type: "model-judge",
    weight: 100,
    enabled: true,
    prerequisites: [],
    config: {
      provider: "codex",
      rubric: "rubric.md",
      rubricText: "Judge correctness.",
      inputs: ["result.json"],
      sampling: {},
    },
  }];

  const taskYaml = renderBenchmark(judged).find((file) =>
    file.path.endsWith("task.yaml"),
  )?.contents;

  expect(taskYaml).toContain("evaluationPolicy:");
  expect(taskYaml).toContain("maxModelJudgeWeight: 100");
  expect(taskYaml).toContain("allowModelJudgeMajority: true");
});
