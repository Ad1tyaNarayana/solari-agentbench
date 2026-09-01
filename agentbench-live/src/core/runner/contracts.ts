import type { GeneratorInput, GenerationResult } from "@/core/agents/codex-generator";
import type { PlannerInput } from "@/core/agents/codex-planner";
import type { RunPlan } from "@/core/domain/plan";
import type { AgentConfig, RunRecord } from "@/core/domain/run";
import type { TaskManifest } from "@/core/domain/task";
import type { RunEventBus } from "@/core/events/run-events";
import type { RunRepository } from "@/core/persistence/repository";
import type { SubmissionPackage } from "@/core/security/package-submission";
import type { DisposableWorkspace } from "@/core/security/workspace";
import type { ScoreBreakdown } from "./scoring";

export type RunRequest = { taskId: string; agentId: string };

export type DryRunReport = {
  taskId: string;
  agentId: string;
  plan: RunPlan;
  budget: TaskManifest["budget"];
  requiredEvidence: TaskManifest["requiredEvidence"];
  estimatedMaximumMinutes: number;
};

export interface PlannerPort {
  plan(input: PlannerInput): Promise<RunPlan>;
}

export interface GeneratorPort {
  generate(input: GeneratorInput): Promise<GenerationResult>;
}

export type VerificationContext = {
  run: RunRecord;
  task: TaskManifest;
  agent: AgentConfig;
  plan: RunPlan;
  submission: SubmissionPackage;
};

export type VerificationResult = {
  score: ScoreBreakdown;
  evidence: Record<string, unknown>;
  logs: string[];
};

export interface VerifierRegistryPort {
  verify(context: VerificationContext): Promise<VerificationResult>;
}

export type OrchestratorDependencies = {
  repository: RunRepository;
  events: RunEventBus;
  planner: PlannerPort;
  generator: GeneratorPort;
  verifier: VerifierRegistryPort;
  getTask(id: string): TaskManifest;
  getAgent(id: string): AgentConfig;
  createWorkspace(runId: string): Promise<DisposableWorkspace>;
  packageSubmission(
    workspace: Pick<DisposableWorkspace, "root">,
  ): Promise<SubmissionPackage>;
  schemaPath: string;
  solariApiKey: string;
};
