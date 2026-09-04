import type { AgentConfig } from "@/core/domain/run";
import type { TaskManifest } from "@/core/domain/task";
import type { RunRequest, RunSelection } from "@/core/runner/contracts";
import { BenchmarkLoader, type LoadedBenchmark } from "./loader";

export const DEFAULT_BENCHMARK_ID = "agentbench-live";

export type BenchmarkSelectionErrorCode =
  | "unknown_benchmark"
  | "unknown_task"
  | "unknown_agent"
  | "benchmark_invalid";

export class BenchmarkSelectionError extends Error {
  constructor(
    readonly code: BenchmarkSelectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BenchmarkSelectionError";
  }
}

export class BenchmarkCatalog {
  constructor(
    private readonly roots: string[],
    private readonly loader: BenchmarkLoader,
  ) {}

  async discover(): Promise<LoadedBenchmark[]> {
    const packs: LoadedBenchmark[] = [];
    const seenBenchmarks = new Set<string>();
    const taskBenchmarks = new Map<string, string>();
    const agentBenchmarks = new Map<string, string>();

    for (const root of this.roots) {
      const loaded = await this.loadRoot(root);
      if (seenBenchmarks.has(loaded.definition.id)) {
        throw new BenchmarkSelectionError(
          "benchmark_invalid",
          `Duplicate benchmark id: ${loaded.definition.id}`,
        );
      }
      seenBenchmarks.add(loaded.definition.id);

      for (const task of loaded.definition.tasks) {
        const previous = taskBenchmarks.get(task.id);
        if (previous) {
          throw new BenchmarkSelectionError(
            "benchmark_invalid",
            `Duplicate task id ${task.id} in benchmarks ${previous} and ${loaded.definition.id}`,
          );
        }
        taskBenchmarks.set(task.id, loaded.definition.id);
      }

      for (const agent of loaded.definition.agents) {
        const previous = agentBenchmarks.get(agent.id);
        if (previous) {
          throw new BenchmarkSelectionError(
            "benchmark_invalid",
            `Duplicate agent id ${agent.id} in benchmarks ${previous} and ${loaded.definition.id}`,
          );
        }
        agentBenchmarks.set(agent.id, loaded.definition.id);
      }
      packs.push(loaded);
    }

    return packs.sort((a, b) =>
      Buffer.from(a.definition.id).compare(Buffer.from(b.definition.id)),
    );
  }

  async getBenchmark(id: string): Promise<LoadedBenchmark> {
    const found = (await this.discover()).find(
      (pack) => pack.definition.id === id,
    );
    if (!found) {
      throw new BenchmarkSelectionError(
        "unknown_benchmark",
        `Unknown benchmark: ${id}`,
      );
    }
    return found;
  }

  async resolveSelection(request: RunRequest): Promise<RunSelection> {
    const loaded = await this.getBenchmark(
      request.benchmarkId ?? DEFAULT_BENCHMARK_ID,
    );
    const rawTask = loaded.definition.tasks.find(
      (task) => task.id === request.taskId,
    );
    if (!rawTask) {
      throw new BenchmarkSelectionError(
        "unknown_task",
        `Unknown task: ${request.taskId}`,
      );
    }
    const rawAgent = loaded.definition.agents.find(
      (agent) => agent.id === request.agentId,
    );
    if (!rawAgent) {
      throw new BenchmarkSelectionError(
        "unknown_agent",
        `Unknown agent: ${request.agentId}`,
      );
    }

    return Object.freeze({
      benchmark: loaded.definition,
      snapshot: loaded.snapshot,
      task: this.projectTask(rawTask, loaded.definition.version),
      agent: this.projectAgent(rawAgent),
    });
  }

  async getTask(id: string): Promise<TaskManifest> {
    for (const pack of await this.discover()) {
      const raw = pack.definition.tasks.find((task) => task.id === id);
      if (raw) return this.projectTask(raw, pack.definition.version);
    }
    throw new BenchmarkSelectionError("unknown_task", `Unknown task: ${id}`);
  }

  async getAgent(id: string): Promise<AgentConfig> {
    for (const pack of await this.discover()) {
      const raw = pack.definition.agents.find((agent) => agent.id === id);
      if (raw) return this.projectAgent(raw);
    }
    throw new BenchmarkSelectionError("unknown_agent", `Unknown agent: ${id}`);
  }

  async listTasks(benchmarkId?: string): Promise<TaskManifest[]> {
    const packs = benchmarkId
      ? [await this.getBenchmark(benchmarkId)]
      : await this.discover();
    return packs
      .flatMap((pack) =>
        pack.definition.tasks.map((task) =>
          this.projectTask(task, pack.definition.version),
        ),
      )
      .sort((a, b) => Buffer.from(a.id).compare(Buffer.from(b.id)));
  }

  async listAgents(benchmarkId?: string): Promise<AgentConfig[]> {
    const packs = benchmarkId
      ? [await this.getBenchmark(benchmarkId)]
      : await this.discover();
    return packs
      .flatMap((pack) =>
        pack.definition.agents.map((agent) => this.projectAgent(agent)),
      )
      .sort((a, b) => Buffer.from(a.id).compare(Buffer.from(b.id)));
  }

  private async loadRoot(root: string): Promise<LoadedBenchmark> {
    try {
      return await this.loader.load(root);
    } catch (error) {
      if (error instanceof BenchmarkSelectionError) throw error;
      throw new BenchmarkSelectionError(
        "benchmark_invalid",
        "Benchmark pack is invalid.",
      );
    }
  }

  private projectAgent(
    raw: LoadedBenchmark["definition"]["agents"][number],
  ): AgentConfig {
    return {
      id: raw.id,
      label: raw.name,
      model: raw.model ?? "",
      reasoningEffort: raw.reasoningEffort as AgentConfig["reasoningEffort"],
    };
  }

  private projectTask(
    raw: LoadedBenchmark["definition"]["tasks"][number],
    benchmarkVersion: string,
  ): TaskManifest {
    const compatibility = raw.compatibility;
    if (!compatibility) {
      throw new BenchmarkSelectionError(
        "benchmark_invalid",
        `Task ${raw.id} is missing its compatibility projection.`,
      );
    }
    return {
      id: raw.id,
      version: benchmarkVersion,
      title: raw.name,
      prompt: raw.prompt,
      allowedPrimitives: [...raw.allowedPrimitives],
      requiredEvidence: [...compatibility.requiredEvidence],
      budget: { ...compatibility.legacyBudgetMs },
      verifier: compatibility.legacyVerifier,
    };
  }
}
