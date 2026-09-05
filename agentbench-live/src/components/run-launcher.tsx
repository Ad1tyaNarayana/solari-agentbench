"use client";

import Link from "next/link";
import { useState } from "react";
import type { AgentConfig, RunRecord } from "@/core/domain/run";
import type { TaskManifest } from "@/core/domain/task";

export function RunLauncher({
  agents,
  tasks,
  benchmarkId,
  benchmarkDigest,
}: {
  agents: AgentConfig[];
  tasks: TaskManifest[];
  benchmarkId?: string;
  benchmarkDigest?: string;
}) {
  const [taskId, setTaskId] = useState(tasks[0]?.id ?? "");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [pending, setPending] = useState(false);
  const [queued, setQueued] = useState<RunRecord>();
  const [error, setError] = useState<string>();

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setQueued(undefined);
    setError(undefined);
    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId, agentId, benchmarkId, benchmarkDigest }),
      });
      const body = (await response.json()) as RunRecord | { error?: string };
      if (!response.ok || !("id" in body)) {
        throw new Error("error" in body && body.error ? body.error : "submission_failed");
      }
      setQueued(body);
      window.dispatchEvent(new Event("agentbench:run-created"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "submission_failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="launcher" onSubmit={submit}>
      <div className="launcher__intro">
        <h2>Run configuration</h2>
        <p>Uses provider allowance and Solari credits. The agent chooses resources after planning.</p>
      </div>
      <label>
        <span>Task</span>
        <select value={taskId} onChange={(event) => setTaskId(event.target.value)}>
          {tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
        </select>
      </label>
      <label>
        <span>Agent</span>
        <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
          {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}
        </select>
      </label>
      <button type="submit" disabled={pending || Boolean(queued) || !taskId || !agentId}>
        {pending ? "Validating…" : queued ? "Run queued" : "Start benchmark"}
      </button>
      <div className="launcher__result" aria-live="polite">
        {queued ? <><Link href={`/runs/${queued.id}`}>View queued run →</Link><button className="launcher__reset" type="button" onClick={() => setQueued(undefined)}>Configure another run</button></> : null}
        {error ? <span>Could not start: {error.replaceAll("_", " ")}</span> : null}
      </div>
    </form>
  );
}
