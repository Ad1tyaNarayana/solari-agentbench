import type { RunRecord } from "@/core/domain/run";
import type { RunEvent, RunEventInput } from "@/core/events/run-events";
import type { DryRunReport, RunRequest } from "@/core/runner/contracts";

export type RunSubmission =
  | { kind: "run"; run: RunRecord }
  | { kind: "dry-run"; report: DryRunReport };

export interface RunApiPort {
  submit(request: RunRequest & { dryRun?: boolean }): Promise<RunSubmission>;
  listRuns(): RunRecord[];
  getRun(id: string): RunRecord | undefined;
  cancelRun(id: string): RunRecord | undefined;
  listEvents(runId: string): RunEvent[];
  subscribe(runId: string, listener: (event: RunEventInput) => void): () => void;
}

export type RunApiErrorCode =
  | "unknown_benchmark"
  | "unknown_task"
  | "unknown_agent"
  | "benchmark_invalid"
  | "preflight_failed";

export class RunApiError extends Error {
  constructor(
    readonly code: RunApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RunApiError";
  }
}
