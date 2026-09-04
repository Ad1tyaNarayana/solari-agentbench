import type { RunPlan } from "./plan";
import type { EvaluationReport } from "@/core/evaluators/types";
import type { EvidenceManifest } from "@/core/evidence/manifest";

export type RunStage =
  | "queued"
  | "loading"
  | "preflight"
  | "planning"
  | "generating"
  | "provisioning"
  | "building"
  | "verifying"
  | "capturing"
  | "completed"
  | "cancelled"
  | "failed";

export type FailureCode =
  | "preflight_failed"
  | "plan_invalid"
  | "agent_timeout"
  | "agent_failed"
  | "submission_invalid"
  | "provision_failed"
  | "build_failed"
  | "verification_failed"
  | "evidence_failed"
  | "cleanup_failed"
  | "evaluator_error"
  | "score_invalid";

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

export type RunProvenance =
  | { kind: "live"; label: string }
  | { kind: "synthetic-demo"; label: string };

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
  provenance?: RunProvenance;
  benchmarkId?: string;
  benchmarkVersion?: string;
  benchmarkDigest?: string;
  snapshotPath?: string;
  providerId?: string;
  harnessId?: string;
  harnessVersion?: string;
  resolvedModel?: string;
  providerOptions?: Record<string, unknown>;
  toolPolicy?: Record<string, unknown>;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  evaluationStatus?: "valid-score" | "invalid-score";
  primaryScore?: number | null;
  evaluationReport?: EvaluationReport;
  evidenceManifest?: EvidenceManifest;
};
