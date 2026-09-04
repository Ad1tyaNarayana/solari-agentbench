import type { AgentConfig } from "@/core/domain/run";
import type { TaskManifest } from "@/core/domain/task";
import { BenchmarkLoader, type LoadedBenchmark } from "./loader";

export class BenchmarkCatalog {
  constructor(private readonly roots: string[], private readonly loader: BenchmarkLoader) {}

  async discover(): Promise<LoadedBenchmark[]> {
    const packs: LoadedBenchmark[] = [];
    const seenBenchmarks = new Map<string, string>();
    const taskRoots = new Map<string, string>();
    const agentRoots = new Map<string, string>();
    for (const root of this.roots) {
      const loaded = await this.loader.load(root);
      const prior = seenBenchmarks.get(loaded.definition.id);
      if (prior) throw new Error(`duplicate benchmark id ${loaded.definition.id} across roots ${prior} and ${root}`);
      seenBenchmarks.set(loaded.definition.id, root);
      for (const task of loaded.definition.tasks) {
        const previous = taskRoots.get(task.id);
        if (previous) throw new Error(`duplicate task id ${task.id} across roots ${previous} and ${root}`);
        taskRoots.set(task.id, root);
      }
      for (const agent of loaded.definition.agents) {
        const previous = agentRoots.get(agent.id);
        if (previous) throw new Error(`duplicate agent id ${agent.id} across roots ${previous} and ${root}`);
        agentRoots.set(agent.id, root);
      }
      packs.push(loaded);
    }
    return packs.sort((a, b) => a.definition.id.localeCompare(b.definition.id));
  }

  async getBenchmark(id: string): Promise<LoadedBenchmark> {
    const found = (await this.discover()).find((pack) => pack.definition.id === id);
    if (!found) throw new Error(`Unknown benchmark: ${id}`);
    return found;
  }

  async getTask(id: string): Promise<TaskManifest> {
    for (const pack of await this.discover()) {
      const raw = pack.definition.tasks.find((task) => task.id === id);
      if (raw) return this.projectTask(raw);
    }
    throw new Error(`Unknown task: ${id}`);
  }

  async getAgent(id: string): Promise<AgentConfig> {
    for (const pack of await this.discover()) {
      const raw = pack.definition.agents.find((agent) => agent.id === id);
      if (raw) return { id: raw.id, label: raw.name, model: raw.model ?? "", reasoningEffort: raw.reasoningEffort as AgentConfig["reasoningEffort"] };
    }
    throw new Error(`Unknown agent: ${id}`);
  }

  async listTasks(): Promise<TaskManifest[]> {
    return (await this.discover()).flatMap((pack) => pack.definition.tasks.map((task) => this.projectTask(task))).sort((a, b) => a.id.localeCompare(b.id));
  }

  async listAgents(): Promise<AgentConfig[]> {
    return (await this.discover()).flatMap((pack) => pack.definition.agents).map((agent) => ({ id: agent.id, label: agent.name, model: agent.model ?? "", reasoningEffort: agent.reasoningEffort as AgentConfig["reasoningEffort"] })).sort((a, b) => a.id.localeCompare(b.id));
  }

  private projectTask(raw: LoadedBenchmark["definition"]["tasks"][number]): TaskManifest {
    const compatibility = raw.compatibility;
    if (!compatibility) throw new Error(`Task ${raw.id} is missing compatibility projection`);
    return { id: raw.id, version: "1.0.0", title: raw.name, prompt: raw.prompt, allowedPrimitives: [...raw.allowedPrimitives], requiredEvidence: [...compatibility.requiredEvidence], budget: { ...compatibility.legacyBudgetMs }, verifier: compatibility.legacyVerifier };
  }
}
