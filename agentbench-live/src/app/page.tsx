import { RunLauncher } from "@/components/run-launcher";
import { buildScoreboardDimensions, Scoreboard } from "@/components/scoreboard";
import { demoRuns } from "@/core/demo/seed";
import { agents as tutorialAgents, listTasks } from "@/core/tasks/registry";
import { getServerContainer } from "@/server/container";

export const dynamic = "force-dynamic";

export default function Home() {
  const tasks = listTasks();
  const persistedRuns = getServerContainer().listRuns();
  const demoMode = persistedRuns.length === 0;
  const runs = demoMode ? demoRuns : [...persistedRuns, ...demoRuns];
  const scoreboard = buildScoreboardDimensions({
    agents: [...tutorialAgents],
    tasks,
    runs: persistedRuns,
  });
  const completed = runs.filter((run) => run.stage === "completed").length;
  const evidenceItems = runs.reduce(
    (count, run) => count + Object.keys(run.evidence ?? {}).length,
    0,
  );

  return (
    <main>
      <header className="site-header shell">
        <a className="wordmark" href="#top" aria-label="AgentBench Live home">
          <span aria-hidden="true">AB</span>
          AgentBench Live
        </a>
        <nav aria-label="Primary navigation">
          <a href="#scoreboard">Scoreboard</a>
          <a href="#launch">Run</a>
          <a href="https://github.com/solari-sdk/solari-cookbook" target="_blank" rel="noreferrer">Source ↗</a>
        </nav>
      </header>

      <section className="hero shell" id="top">
        <div className="hero__copy">
          <p className="eyebrow"><span className="pulse" aria-hidden="true" /> Live evidence, not agent claims</p>
          <h1>AgentBench <em>Live</em></h1>
          <p className="hero__lede">
            An evidence-first benchmark to choose which agent configuration can be trusted with a real workflow. Every build is independently rerun inside fresh Solari infrastructure.
          </p>
          <div className="primitive-row" aria-label="Solari primitives used">
            <span>01 · Browser</span><span>02 · Sandbox</span><span>03 · Desktop</span>
          </div>
        </div>
        <aside className="hero__proof" aria-label="Benchmark summary">
          <p>{demoMode ? "Representative demo matrix" : "Equal prompt. Equal budget."}</p>
          <dl>
            <div><dt>Matrix</dt><dd>{scoreboard.agents.length} × {scoreboard.tasks.length}</dd></div>
            <div><dt>Completed</dt><dd>{completed.toString().padStart(2, "0")}</dd></div>
            <div><dt>Evidence fields</dt><dd>{evidenceItems.toString().padStart(2, "0")}</dd></div>
          </dl>
          <small>{demoMode ? "Seeded DTOs demonstrate the public evidence contract. Launch a run to replace them with local observations." : "Scores come from observed assertions, reproductions, recordings, screenshots, and logs."}</small>
        </aside>
      </section>

      <section className="scoreboard-section shell" id="scoreboard">
        <div className="section-heading section-heading--wide">
          <div><p className="eyebrow">{demoMode ? "Seeded public demonstration" : "Latest verified matrix"}</p><h2>Scoreboard</h2></div>
          <p>Each cell links to its complete execution trace. Missing runs stay visibly missing.</p>
        </div>
        <Scoreboard agents={scoreboard.agents} tasks={scoreboard.tasks} runs={runs} />
      </section>

      <section className="launch-section shell" id="launch">
        <RunLauncher agents={[...tutorialAgents]} tasks={tasks} />
      </section>

      <section className="method-strip">
        <div className="shell method-strip__inner">
          <p className="eyebrow">The benchmark contract</p>
          <ol>
            <li><span>01</span><strong>Plan</strong><p>Choose only the Solari primitives the task needs.</p></li>
            <li><span>02</span><strong>Build</strong><p>Generate inside an isolated, disposable workspace.</p></li>
            <li><span>03</span><strong>Verify</strong><p>Rebuild in clean infrastructure owned by the grader.</p></li>
            <li><span>04</span><strong>Prove</strong><p>Publish sanitized measurements and canonical evidence.</p></li>
          </ol>
        </div>
      </section>

      <footer className="site-footer shell">
        <p>Built with Codex. Verified with Solari.</p>
        <p>Local-first · SQLite · no API billing for Codex</p>
      </footer>
    </main>
  );
}
