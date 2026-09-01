import type { AgentConfig } from "@/core/domain/run";
import type { TaskManifest } from "@/core/domain/task";
import { sameStatsTask } from "./same-stats";
import { urlShortenerTask } from "./url-shortener";

const tasks: TaskManifest[] = [urlShortenerTask, sameStatsTask];

export const agents = [
  {
    id: "sol-low",
    label: "Sol · Low",
    model: "gpt-5.6-sol",
    reasoningEffort: "low",
  },
  {
    id: "luna-high",
    label: "Luna · High",
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
  },
] as const satisfies readonly AgentConfig[];

export function listTasks(): TaskManifest[] {
  return [...tasks];
}

export function getTask(id: string): TaskManifest {
  const task = tasks.find((candidate) => candidate.id === id);
  if (!task) {
    throw new Error(`Unknown task: ${id}`);
  }
  return task;
}

export function getAgent(id: string): AgentConfig {
  const agent = agents.find((candidate) => candidate.id === id);
  if (!agent) throw new Error(`Unknown agent: ${id}`);
  return { ...agent };
}
