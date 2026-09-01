import Link from "next/link";
import { notFound } from "next/navigation";
import { EvidencePanel } from "@/components/evidence-panel";
import { LiveRun } from "@/components/live-run";
import { StageTimeline } from "@/components/stage-timeline";
import { demoRuns } from "@/core/demo/seed";
import { getAgent, getTask } from "@/core/tasks/registry";
import { getServerContainer } from "@/server/container";

export const dynamic = "force-dynamic";

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const run =
    getServerContainer().getRun(id) ?? demoRuns.find((candidate) => candidate.id === id);
  if (!run) notFound();
  const task = getTask(run.taskId);
  const agent = getAgent(run.agentId);
  const scores = run.score ? Object.entries(run.score) : [];

  return (
    <main className="run-page shell">
      <header className="run-page__nav">
        <Link href="/">← Scoreboard</Link>
        <span>Run {run.id.slice(0, 8)}</span>
      </header>

      <section className="run-hero">
        <div>
          <p className="eyebrow">{task.title} · v{run.taskVersion}</p>
          <h1>{agent.label}</h1>
          <p>{run.model} · {run.reasoningEffort} reasoning</p>
        </div>
        <div className={`run-outcome run-outcome--${run.stage}`}>
          <span>{run.stage}</span>
          <strong>{run.score?.total ?? "—"}</strong>
          <small>Total score / 100</small>
        </div>
      </section>

      {run.provenance?.kind === "synthetic-demo" ? (
        <aside className="failure-banner">
          <strong>{run.provenance.label}</strong>
          <p>This detail page contains illustrative seed data and locally generated mock artifacts. It is not live benchmark proof.</p>
        </aside>
      ) : null}

      {run.stage === "failed" ? (
        <aside className="failure-banner">
          <strong>{run.failureCode?.replaceAll("_", " ") ?? "Run failed"}</strong>
          <p>{run.failureDetail ?? "No additional failure detail was recorded."}</p>
          <small>Last completed: {run.lastSuccessfulStage ?? "none"}</small>
        </aside>
      ) : null}

      <div className="run-layout">
        <div className="run-layout__main">
          <StageTimeline run={run} />
          <EvidencePanel run={run} />
        </div>
        <aside className="run-layout__rail">
          <section className="panel score-panel">
            <div className="section-heading"><p className="eyebrow">Observed result</p><h2>Score</h2></div>
            {scores.length > 0 ? (
              <dl>{scores.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
            ) : <p className="empty-state">A score appears after independent verification.</p>}
          </section>
          <LiveRun runId={run.id} initialStage={run.stage} />
          <section className="panel metadata-panel">
            <h2>Run record</h2>
            <dl>
              <div><dt>Created</dt><dd>{new Date(run.createdAt).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })}</dd></div>
              <div><dt>Duration</dt><dd>{run.durationMs ? `${(run.durationMs / 1000).toFixed(1)} s` : "In progress"}</dd></div>
              <div><dt>Task version</dt><dd>{run.taskVersion}</dd></div>
            </dl>
          </section>
        </aside>
      </div>
    </main>
  );
}
