import type { RunRecord } from "@/core/domain/run";
import type { RunEvent } from "@/core/events/run-events";

export type CreateRunInput = {
  taskId: string;
  agentId: string;
  taskVersion?: string;
  model?: string;
  reasoningEffort?: "low" | "high";
};

export type RunUpdate = Partial<
  Omit<RunRecord, "id" | "taskId" | "agentId" | "createdAt">
>;

export type AppendRunEventInput = Pick<RunEvent, "kind" | "payload">;

export interface RunRepository {
  create(input: CreateRunInput): RunRecord;
  get(id: string): RunRecord | undefined;
  list(): RunRecord[];
  update(id: string, patch: RunUpdate): RunRecord;
  appendEvent(runId: string, input: AppendRunEventInput): RunEvent;
  listEvents(runId: string): RunEvent[];
}
