import { readFile, readdir } from "node:fs/promises";
import { parseAgentsFile, parseBenchmarkFile, parseTaskFile } from "./schema";
import type { BenchmarkDefinition, BenchmarkTaskDefinition } from "./types";
import { resolvePackDirectory, resolvePackFile } from "./paths";
import { createBenchmarkSnapshot, type BenchmarkSnapshot } from "./snapshot";
export type LoadedBenchmark = { definition: BenchmarkDefinition; snapshot: BenchmarkSnapshot };
const assetKeys = new Set(["schema", "rubric", "script", "expected", "fixture"]);
function localPaths(value: unknown, output: string[] = [], key = ""): string[] {
  if (typeof value === "string" && (assetKeys.has(key) || (key === "command" && /[\\/].+|\.(?:py|mjs|js|json|yaml|yml|sh|rb)$/i.test(value)))) output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => localPaths(item, output, key));
  else if (value && typeof value === "object") Object.entries(value).forEach(([childKey, item]) => localPaths(item, output, childKey));
  return output;
}
export class BenchmarkLoader {
  constructor(private readonly snapshotsRoot: string) {}
  async load(packRoot: string): Promise<LoadedBenchmark> {
    const manifest = parseBenchmarkFile(await readFile(await resolvePackFile(packRoot, "benchmark.yaml"), "utf8")); const agents = parseAgentsFile(await readFile(await resolvePackFile(packRoot, "agents.yaml"), "utf8")); const tasks: BenchmarkTaskDefinition[] = []; const semantic = ["benchmark.yaml", "agents.yaml"];
    for (const taskRoot of manifest.taskRoots) { const rootPath = await resolvePackDirectory(packRoot, taskRoot); const entries = await readdir(rootPath, { withFileTypes: true }); const folders: string[] = []; for (const entry of entries) { try { await resolvePackDirectory(packRoot, `${taskRoot}/${entry.name}`); folders.push(entry.name); } catch (error) { if (entry.isSymbolicLink()) throw error; } } folders.sort(); const discovered: Array<{ task: BenchmarkTaskDefinition; taskRelative: string; prefix: string }> = []; for (const folder of folders) { const taskRelative = `${taskRoot}/${folder}/task.yaml`; const task = parseTaskFile(await readFile(await resolvePackFile(packRoot, taskRelative), "utf8")); if (tasks.some((existing) => existing.id === task.id) || discovered.some((existing) => existing.task.id === task.id)) throw new Error(`duplicate task id: ${task.id}`); discovered.push({ task, taskRelative, prefix: `${taskRoot}/${folder}` }); } for (const item of discovered) { const { task, taskRelative, prefix } = item; const promptRelative = `${prefix}/${task.promptPath}`; task.prompt = await readFile(await resolvePackFile(packRoot, promptRelative), "utf8"); semantic.push(taskRelative, promptRelative, ...task.fixtures.map((path) => `${prefix}/${path}`)); for (const evaluator of task.evaluators) { if (evaluator.type === "schema" || evaluator.type === "model-judge" || evaluator.type === "command") for (const path of localPaths(evaluator.config)) semantic.push(`${prefix}/${path}`); } tasks.push(task); } }
    tasks.sort((a, b) => a.id.localeCompare(b.id)); agents.sort((a, b) => a.id.localeCompare(b.id)); const snapshot = await createBenchmarkSnapshot({ packRoot, semanticFiles: semantic, snapshotsRoot: this.snapshotsRoot }); const definition: BenchmarkDefinition = { ...manifest, root: packRoot, tasks, agents }; return { definition, snapshot };
  }
}
