import type { RunStage } from "@/core/domain/run";

const allowed: Record<RunStage, RunStage[]> = {
  queued: ["loading", "failed", "cancelled"],
  loading: ["preflight", "failed", "cancelled"],
  preflight: ["planning", "failed", "cancelled"],
  planning: ["generating", "failed", "cancelled"],
  generating: ["provisioning", "failed", "cancelled"],
  provisioning: ["building", "failed", "cancelled"],
  building: ["verifying", "failed", "cancelled"],
  verifying: ["capturing", "completed", "failed", "cancelled"],
  capturing: ["completed", "failed", "cancelled"],
  completed: [],
  cancelled: [],
  failed: [],
};

export function transition(current: RunStage, next: RunStage): RunStage {
  if (!allowed[current].includes(next)) {
    throw new Error(`Invalid transition from ${current} to ${next}`);
  }
  return next;
}
