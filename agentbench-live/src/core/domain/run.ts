import type { RunPlan } from "./plan";

export type RunStage =
  | "queued"
  | "planning"
  | "generating"
  | "provisioning"
  | "building"
  | "verifying"
  | "capturing"
  | "completed"
  | "failed";

export type FailureCode =
  | "plan_invalid"
  | "agent_timeout"
  | "agent_failed"
  | "submission_invalid"
  | "provision_failed"
  | "build_failed"
  | "verification_failed"
  | "evidence_failed"
  | "cleanup_failed";

export type ReasoningEffort = "low" | "high";

export type AgentConfig = {
  id: string;
  label: string;
  model: string;
  reasoningEffort: ReasoningEffort;
};

export type CleanupIssue = {
  code: "cleanup_failed";
  detail: string;
};

export type RunRecord = {
  id: string;
  taskId: string;
  taskVersion?: string;
  agentId: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  stage: RunStage;
  lastSuccessfulStage?: RunStage;
  runPlan?: RunPlan;
  score?: Record<string, number>;
  evidence?: Record<string, unknown>;
  failureCode?: FailureCode;
  failureDetail?: string;
  sanitizedLogs: string[];
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  cleanupIssues?: CleanupIssue[];
};
