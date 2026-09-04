import type { AgentConfig, RunRecord } from "@/core/domain/run";
import type { TaskManifest } from "@/core/domain/task";
import { RunCard } from "./run-card";

type ScoreboardAgent = Pick<AgentConfig, "id" | "label"> & {
  model?: string;
  reasoningEffort?: AgentConfig["reasoningEffort"];
  providerId?: string;
  harnessId?: string;
  harnessVersion?: string;
};

type ScoreboardTask = Pick<TaskManifest, "id" | "title">;

export function buildScoreboardDimensions(input: {
  agents: ScoreboardAgent[];
  tasks: ScoreboardTask[];
  runs: RunRecord[];
}): { agents: ScoreboardAgent[]; tasks: ScoreboardTask[] } {
  const agents = [...input.agents];
  const tasks = [...input.tasks];
  const knownAgentIds = new Set(agents.map((agent) => agent.id));
  const knownTaskIds = new Set(tasks.map((task) => task.id));
  const latestByAgent = new Map<string, RunRecord>();

  for (const run of input.runs) {
    if (!knownTaskIds.has(run.taskId)) {
      knownTaskIds.add(run.taskId);
      tasks.push({ id: run.taskId, title: run.taskId });
    }
    const latest = latestByAgent.get(run.agentId);
    if (!latest || run.createdAt.localeCompare(latest.createdAt) > 0) {
      latestByAgent.set(run.agentId, run);
    }
  }

  for (const [agentId, run] of latestByAgent) {
    if (knownAgentIds.has(agentId)) continue;
    knownAgentIds.add(agentId);
    agents.push({
      id: agentId,
      label: agentId,
      model: run.model,
      reasoningEffort: run.reasoningEffort,
      providerId: run.providerId,
      harnessId: run.harnessId,
      harnessVersion: run.harnessVersion,
    });
  }

  return { agents, tasks };
}

function latestRun(
  runs: RunRecord[],
  agentId: string,
  taskId: string,
): RunRecord | undefined {
  return runs
    .filter((run) => run.agentId === agentId && run.taskId === taskId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

export function Scoreboard({
  agents,
  tasks,
  runs,
}: {
  agents: ScoreboardAgent[];
  tasks: ScoreboardTask[];
  runs: RunRecord[];
}) {
  return (
    <div className="scoreboard-shell">
      <table className="scoreboard">
        <caption className="sr-only">
          Latest benchmark result for each agent and task
        </caption>
        <thead>
          <tr>
            <th scope="col">Agent configuration</th>
            {tasks.map((task) => (
              <th scope="col" key={task.id}>
                {task.title}
              </th>
            ))}
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => {
            const harness = agent.harnessId
              ? `${agent.harnessId}${agent.harnessVersion ? ` · v${agent.harnessVersion}` : ""}`
              : undefined;
            const identity = [
              agent.model,
              agent.reasoningEffort,
              agent.providerId,
              harness,
            ].filter(Boolean).join(" · ");
            const agentRuns = tasks.map((task) =>
              latestRun(runs, agent.id, task.id),
            );
            const total = agentRuns.reduce(
              (sum, run) => sum + (run?.score?.total ?? 0),
              0,
            );
            return (
              <tr key={agent.id}>
                <th scope="row">
                  <span>{agent.label}</span>
                  <small>{identity || "Identity not recorded"}</small>
                </th>
                {agentRuns.map((run, index) => (
                  <td key={tasks[index].id}>
                    {run ? (
                      <RunCard run={run} />
                    ) : (
                      <span className="empty-cell">Not run</span>
                    )}
                  </td>
                ))}
                <td className="scoreboard__total">{total || "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
