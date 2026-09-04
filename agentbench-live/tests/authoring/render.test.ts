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
