import Link from "next/link";
import { TaskWorkbench } from "@/components/task-workbench";
import { RunUpdates } from "@/components/run-updates";
import { getServerContainer } from "@/server/container";
import { loadTaskLibrary } from "@/server/task-library";

export const dynamic = "force-dynamic";

export default async function Home() {
  const items = await loadTaskLibrary();
  const runs = getServerContainer().listRuns().filter(run => run.provenance?.kind !== "synthetic-demo");
  const active = runs.filter(run => !["completed", "failed", "cancelled"].includes(run.stage)).length;
  return <main className="shell workbench-page">
    <RunUpdates initialSignature={JSON.stringify(getServerContainer().listRuns())} />
    <section className="workspace-heading"><div><h1>AgentBench Live</h1><p>Run agents against your tasks. Inspect what actually passed.</p></div><a className="secondary-link" href="https://github.com/Ad1tyaNarayana/solari-agentbench" target="_blank" rel="noreferrer">GitHub</a></section>
    <section className="workspace-summary" aria-label="Observed benchmark summary"><span><strong>{items.length}</strong> tasks</span><span><strong>{runs.length}</strong> runs</span><span><strong>{active}</strong> active</span><span className="workspace-summary__note">Local workspace</span></section>
    <TaskWorkbench items={items} />
    <section id="scoreboard" className="results-section"><div className="section-heading section-heading--wide"><div><h2>Runs</h2></div><p>Results are comparable only on the same task snapshot.</p></div>
      {runs.length ? <div className="results-table-wrap"><table className="results-table"><thead><tr><th>Task / snapshot</th><th>Agent</th><th>Status</th><th>Quality score</th><th>Evidence</th></tr></thead><tbody>{runs.map(run => <tr key={run.id}><td><strong>{items.find(i => i.task.id === run.taskId)?.task.title ?? run.taskId}</strong><small>{run.benchmarkId ?? "Legacy"} · {run.benchmarkDigest?.slice(0, 10) ?? "No snapshot"}</small></td><td>{run.agentId}</td><td><span className={`status-badge status-badge--${run.stage}`}>{run.stage}</span></td><td>{run.primaryScore ?? run.score?.total ?? "—"}{run.score?.timeAdjusted !== undefined ? <small>{run.score.timeAdjusted} time-adjusted</small> : null}</td><td><Link className="secondary-link" href={`/runs/${run.id}`}>Inspect run ↗</Link></td></tr>)}</tbody></table></div> : <div className="workspace-empty"><h3>No runs yet</h3><p>Start a benchmark to record its score, checks, and artifacts.</p><Link href="/runs/demo-sol-url">View example run</Link><small>Synthetic example · excluded from results.</small></div>}
    </section>
    <footer className="site-footer"><p>AgentBench · local evaluation runner</p><p>Execution infrastructure: Solari</p></footer>
  </main>;
}
