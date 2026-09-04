import { stringify } from "yaml";
import { parseAgentsFile, parseBenchmarkFile, parseTaskFile } from "@/core/benchmarks/schema";
import { DEFAULT_EVALUATION_POLICY } from "@/core/benchmarks/types";
import type { BenchmarkDraft, RenderedBenchmarkFile } from "./types";

const newline = (value: string) => `${value.replace(/\r\n/g, "\n").replace(/\n+$/, "")}\n`;
function yaml(value: unknown): string { return newline(stringify(value, { indent: 2, lineWidth: 0, aliasDuplicateObjects: false, sortMapEntries: false })); }

export function renderBenchmark(draft: BenchmarkDraft): RenderedBenchmarkFile[] {
  const benchmark = { schemaVersion: 1, id: draft.id, name: draft.name, version: draft.version, ...(draft.description ? { description: draft.description } : {}), taskRoots: ["tasks"], defaults: draft.defaults };
  const files: RenderedBenchmarkFile[] = [
    { path: "benchmark.yaml", contents: yaml(benchmark), language: "yaml" },
    { path: "agents.yaml", contents: yaml({ schemaVersion: 1, agents: draft.agents }), language: "yaml" },
  ];
  parseBenchmarkFile(files[0].contents); parseAgentsFile(files[1].contents);
  for (const task of draft.tasks) {
    const evaluators = task.evaluators.map((evaluator) => {
      const config = { ...evaluator.config };
      if (evaluator.type === "model-judge" && typeof config.rubric === "string" && typeof config.rubricText === "string") {
        files.push({ path: `tasks/${task.id}/${config.rubric}`, contents: newline(config.rubricText), language: "markdown" });
        delete config.rubricText;
      }
      if (evaluator.type === "schema" && typeof config.schema === "string" && typeof config.schemaText === "string") {
        files.push({ path: `tasks/${task.id}/${config.schema}`, contents: newline(config.schemaText), language: "json" });
        delete config.schemaText;
      }
      return { ...evaluator, config };
    });
    const taskFile = { schemaVersion: 1, id: task.id, name: task.name, prompt: "prompt.md", fixtures: task.fixtures, resources: { allowed: task.allowedPrimitives, planningRequired: task.planningRequired, budget: task.resourceLimits }, submission: task.submission, evaluationPolicy: task.evaluationPolicy ?? DEFAULT_EVALUATION_POLICY, evaluators };
    const contents = yaml(taskFile); parseTaskFile(contents);
    files.push({ path: `tasks/${task.id}/task.yaml`, contents, language: "yaml" });
    files.push({ path: `tasks/${task.id}/prompt.md`, contents: newline(task.prompt), language: "markdown" });
  }
  return files.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
}
