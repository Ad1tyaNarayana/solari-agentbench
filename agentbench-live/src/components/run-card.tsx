import Link from "next/link";
import type { RunRecord, RunStage } from "@/core/domain/run";

const failureStages: Partial<Record<NonNullable<RunRecord["failureCode"]>, RunStage>> = {
  plan_invalid: "planning",
  agent_timeout: "generating",
  agent_failed: "generating",
  submission_invalid: "generating",
  provision_failed: "provisioning",
  build_failed: "building",
  verification_failed: "verifying",
  evidence_failed: "capturing",
  cleanup_failed: "capturing",
};

export function RunCard({ run }: { run: RunRecord }) {
  const total = run.score?.total;
  const failedAt = run.failureCode ? failureStages[run.failureCode] : undefined;
  const terminal = run.stage === "completed" || run.stage === "failed";
  const status = run.stage === "completed" ? "Passed" : run.stage === "failed" ? "Failed" : "Running";

  return (
    <Link
      href={`/runs/${run.id}`}
      className={`run-card run-card--${run.stage}`}
      data-testid={`run-card-${run.id}`}
      aria-label={`${total ?? "No score"} · ${status}`}
    >
      <span className="run-card__score">{typeof total === "number" ? total : "—"}</span>
      <span className="run-card__status">{status}</span>
      {run.stage === "failed" ? (
        <span className="run-card__detail">
          Failed during {failedAt ?? "execution"}
          {run.lastSuccessfulStage ? (
            <small>Last completed: {run.lastSuccessfulStage}</small>
          ) : null}
        </span>
      ) : !terminal ? (
        <span className="run-card__detail">Current stage: {run.stage}</span>
      ) : null}
    </Link>
  );
}
