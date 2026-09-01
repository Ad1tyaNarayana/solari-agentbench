import type { RunStage } from "@/core/domain/run";

const allowed: Record<RunStage, RunStage[]> = {
  queued: ["planning", "failed"],
  planning: ["generating", "failed"],
  generating: ["provisioning", "failed"],
  provisioning: ["building", "failed"],
  building: ["verifying", "failed"],
  verifying: ["capturing", "completed", "failed"],
  capturing: ["completed", "failed"],
  completed: [],
  failed: [],
};

export function transition(current: RunStage, next: RunStage): RunStage {
  if (!allowed[current].includes(next)) {
    throw new Error(`Invalid transition from ${current} to ${next}`);
  }
  return next;
}
