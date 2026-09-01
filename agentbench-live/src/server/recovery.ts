import type { FailureCode, RunRecord, RunStage } from "@/core/domain/run";
import type { RunEventBus } from "@/core/events/run-events";
import type { RunRepository } from "@/core/persistence/repository";
import { redact } from "@/core/security/redact";

const terminalStages = new Set<RunStage>(["completed", "failed"]);

function recoveryFailureCode(stage: RunStage): FailureCode {
  if (stage === "provisioning") return "provision_failed";
  if (stage === "building") return "build_failed";
  if (stage === "verifying") return "verification_failed";
  if (stage === "capturing") return "evidence_failed";
  return "agent_failed";
}

function abandon(
  repository: RunRepository,
  run: RunRecord,
  completedAt: string,
): void {
  const failureCode = recoveryFailureCode(run.stage);
  repository.update(run.id, {
    stage: "failed",
    failureCode,
    failureDetail: `Run was abandoned by a previous server process during ${run.stage}.`,
    completedAt,
  });
  repository.appendEvent(run.id, {
    kind: "stage",
    payload: { stage: "failed", failureCode, recovery: true },
  });
}

export function reconcileAbandonedRuns(
  repository: RunRepository,
  now: () => string = () => new Date().toISOString(),
): number {
  const abandoned = repository
    .list()
    .filter((run) => !terminalStages.has(run.stage));
  for (const run of abandoned) abandon(repository, run, now());
  return abandoned.length;
}

export function persistDetachedQueueFailure(input: {
  repository: RunRepository;
  events: RunEventBus;
  runId: string;
  error: unknown;
  now?: () => string;
}): void {
  const run = input.repository.get(input.runId);
  if (!run || terminalStages.has(run.stage)) return;
  const failureCode = recoveryFailureCode(run.stage);
  const detail = redact(
    input.error instanceof Error ? input.error.message : String(input.error),
  );
  input.repository.update(run.id, {
    stage: "failed",
    failureCode,
    failureDetail: `Detached queue failure: ${detail}`,
    completedAt: (input.now ?? (() => new Date().toISOString()))(),
  });
  const event = input.repository.appendEvent(run.id, {
    kind: "stage",
    payload: { stage: "failed", failureCode, detached: true },
  });
  input.events.publish(run.id, event);
}

type ServerContainerRegistry = typeof globalThis & {
  __agentbenchServerContainers?: Map<string, unknown>;
};

export function getOrCreateGlobalServerContainer<T>(
  key: string,
  factory: () => T,
): T {
  const shared = globalThis as ServerContainerRegistry;
  shared.__agentbenchServerContainers ??= new Map<string, unknown>();
  if (!shared.__agentbenchServerContainers.has(key)) {
    shared.__agentbenchServerContainers.set(key, factory());
  }
  return shared.__agentbenchServerContainers.get(key) as T;
}
