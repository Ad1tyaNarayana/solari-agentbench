import type { AgentConfig, RunRecord } from "@/core/domain/run";
import type { TaskManifest } from "@/core/domain/task";
import { RunCard } from "./run-card";

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
  agents: AgentConfig[];
  tasks: TaskManifest[];
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
                  <small>{agent.model} · {agent.reasoningEffort}</small>
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
