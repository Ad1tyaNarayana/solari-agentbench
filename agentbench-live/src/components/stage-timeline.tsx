import type { RunRecord, RunStage } from "@/core/domain/run";

const stages: Exclude<RunStage, "failed">[] = [
  "queued",
  "planning",
  "generating",
  "provisioning",
  "building",
  "verifying",
  "capturing",
  "completed",
];

function stageState(run: RunRecord, stage: Exclude<RunStage, "failed">) {
  const current = run.stage === "failed" ? run.lastSuccessfulStage : run.stage;
  const currentIndex = current ? stages.indexOf(current as Exclude<RunStage, "failed">) : -1;
  const index = stages.indexOf(stage);
  if (run.stage === stage) return "current";
  if (run.stage === "completed" || index < currentIndex) return "complete";
  if (index === currentIndex && run.stage === "failed") return "complete";
  return "pending";
}

export function StageTimeline({ run }: { run: RunRecord }) {
  return (
    <section className="panel" aria-labelledby="timeline-heading">
      <div className="section-heading">
        <p className="eyebrow">Execution trace</p>
        <h2 id="timeline-heading">Lifecycle</h2>
      </div>
      <ol className="stage-timeline">
        {stages.map((stage) => (
          <li key={stage} data-state={stageState(run, stage)}>
            <span aria-hidden="true" />
            {stage}
          </li>
        ))}
      </ol>
      {run.runPlan ? (
        <div className="plan-block">
          <h3>Agent-selected primitives</h3>
          <dl>
            {run.runPlan.primitives.map((primitive) => (
              <div key={primitive}>
                <dt><strong>{primitive}</strong></dt>
                <dd>{run.runPlan?.reason[primitive]}</dd>
              </div>
            ))}
          </dl>
          <p><strong>Verification strategy:</strong> {run.runPlan.verificationStrategy}</p>
        </div>
      ) : null}
    </section>
  );
}
