import { readFile, readdir } from "node:fs/promises";
import { resolvePackDirectory, resolvePackFile } from "./paths";
import { parseAgentsFile, parseBenchmarkFile, parseTaskFile } from "./schema";
import {
  compareUtf8Bytes,
  createBenchmarkSnapshot,
  type BenchmarkSnapshot,
  type BenchmarkSnapshotSourceFile,
} from "./snapshot";
import type { BenchmarkDefinition, BenchmarkTaskDefinition } from "./types";

export type LoadedBenchmark = {
  definition: BenchmarkDefinition;
  snapshot: BenchmarkSnapshot;
};

function evaluatorAssets(type: string, config: Record<string, unknown>): string[] {
  if (type === "schema") {
    return typeof config.schema === "string" ? [config.schema] : [];
  }
  if (type === "model-judge") {
    return typeof config.rubric === "string" ? [config.rubric] : [];
  }
  if (type === "command") {
    const paths = ["script", "expected", "fixture"].flatMap((key) =>
      typeof config[key] === "string" ? [config[key] as string] : [],
    );
    const command = Array.isArray(config.command) ? config.command : [];
    return [
      ...paths,
      ...command.filter(
        (value): value is string =>
          typeof value === "string" &&
          /[\\/].+|\.(?:py|mjs|js|json|yaml|yml|sh|rb)$/i.test(value),
      ),
    ];
  }
  return [];
}

export class BenchmarkLoader {
  constructor(private readonly snapshotsRoot: string) {}

  async load(packRoot: string): Promise<LoadedBenchmark> {
    const materialized = new Map<
      string,
      Promise<BenchmarkSnapshotSourceFile>
    >();
    const loadFile = (relativePath: string) => {
      const path = relativePath.replaceAll("\\", "/");
      let pending = materialized.get(path);
      if (!pending) {
        pending = (async () => ({
          path,
          content: await readFile(await resolvePackFile(packRoot, path)),
        }))();
        materialized.set(path, pending);
      }
      return pending;
    };

    const benchmarkFile = await loadFile("benchmark.yaml");
    const manifest = parseBenchmarkFile(benchmarkFile.content.toString("utf8"));
    const agentsFile = await loadFile("agents.yaml");
    const agents = parseAgentsFile(agentsFile.content.toString("utf8"));
    const tasks: BenchmarkTaskDefinition[] = [];

    for (const taskRoot of manifest.taskRoots) {
      const rootPath = await resolvePackDirectory(packRoot, taskRoot);
      const entries = await readdir(rootPath, { withFileTypes: true });
      const folders: string[] = [];
      for (const entry of entries) {
        try {
          await resolvePackDirectory(packRoot, `${taskRoot}/${entry.name}`);
          folders.push(entry.name);
        } catch (error) {
          if (entry.isSymbolicLink()) throw error;
        }
      }
      folders.sort(compareUtf8Bytes);

      const discovered: Array<{
        task: BenchmarkTaskDefinition;
        prefix: string;
      }> = [];
      for (const folder of folders) {
        const taskRelative = `${taskRoot}/${folder}/task.yaml`;
        const taskFile = await loadFile(taskRelative);
        const task = parseTaskFile(taskFile.content.toString("utf8"));
        if (
          tasks.some((existing) => existing.id === task.id) ||
          discovered.some((existing) => existing.task.id === task.id)
        ) {
          throw new Error(`duplicate task id: ${task.id}`);
        }
        discovered.push({ task, prefix: `${taskRoot}/${folder}` });
      }

      for (const { task, prefix } of discovered) {
        const promptFile = await loadFile(`${prefix}/${task.promptPath}`);
        task.prompt = promptFile.content.toString("utf8");
        for (const fixture of task.fixtures) {
          await loadFile(`${prefix}/${fixture}`);
        }
        for (const evaluator of task.evaluators) {
          for (const asset of evaluatorAssets(evaluator.type, evaluator.config)) {
            await loadFile(`${prefix}/${asset}`);
          }
        }
        tasks.push(task);
      }
    }

    tasks.sort((left, right) => compareUtf8Bytes(left.id, right.id));
    agents.sort((left, right) => compareUtf8Bytes(left.id, right.id));
    const snapshot = await createBenchmarkSnapshot({
      files: await Promise.all(materialized.values()),
      snapshotsRoot: this.snapshotsRoot,
    });
    const definition: BenchmarkDefinition = {
      ...manifest,
      root: packRoot,
      tasks,
      agents,
    };
    return { definition, snapshot };
  }
}
