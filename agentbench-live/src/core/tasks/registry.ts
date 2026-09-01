import type { TaskManifest } from "@/core/domain/task";

const tasks: TaskManifest[] = [];

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
