import type { AgentConfig, RunRecord } from "@/core/domain/run";
import type { TaskManifest } from "@/core/domain/task";
import { RunQueue } from "./queue";
import type { AgentBenchOrchestrator } from "./orchestrator";

export type MatrixOptions = {
  benchmarkId: string;
  confirm: boolean;
  concurrency: number;
  agents: AgentConfig[];
  tasks: TaskManifest[];
};

export async function runMatrix(
  orchestrator: Pick<AgentBenchOrchestrator, "run">,
  options: MatrixOptions,
): Promise<RunRecord[]> {
  if (!options.confirm) throw new Error("Matrix confirmation required");
  const queue = new RunQueue(options.concurrency);
  const jobs: Array<Promise<RunRecord>> = [];
  for (const agent of options.agents) {
    for (const task of options.tasks) {
      jobs.push(
        queue.enqueue(() =>
          orchestrator.run({
            benchmarkId: options.benchmarkId,
            taskId: task.id,
            agentId: agent.id,
          }),
        ),
      );
    }
  }
  return Promise.all(jobs);
}
