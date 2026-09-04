import type { BenchmarkSnapshot } from "@/core/benchmarks/snapshot";
import type { BenchmarkDefinition } from "@/core/benchmarks/types";
import type { CredentialStore } from "@/core/credentials/types";
import type { RunPlan } from "@/core/domain/plan";
import type { AgentConfig, CleanupIssue, RunRecord } from "@/core/domain/run";
import type { TaskManifest } from "@/core/domain/task";
import type { RunEventBus } from "@/core/events/run-events";
import type { RunRepository } from "@/core/persistence/repository";
import type { AgentEventSink } from "@/core/providers/events";
import type { AgentProviderRegistry } from "@/core/providers/registry";
import type { AgentToolBroker } from "@/core/providers/types";
import type { SubmissionPackage } from "@/core/security/package-submission";
import type { DisposableWorkspace } from "@/core/security/workspace";
import type { ResourceSupervisor } from "@/core/solari/resource-supervisor";
import type { ScoreBreakdown } from "./scoring";

export type RunRequest = {
  benchmarkId?: string;
  taskId: string;
  agentId: string;
};

export type RunSelection = {
  benchmark: BenchmarkDefinition;
  snapshot: BenchmarkSnapshot;
  task: TaskManifest;
  agent: AgentConfig;
};

export type CreatedRun = {
  run: RunRecord;
  selection: RunSelection;
};

export type DryRunReport = {
  taskId: string;
  agentId: string;
  plan: RunPlan;
  budget: TaskManifest["budget"];
  requiredEvidence: TaskManifest["requiredEvidence"];
  estimatedMaximumMinutes: number;
  provider: string;
  providerCapabilities: Record<string, boolean>;
  credentialConfigured: boolean;
  plannedTools: string[];
  networkUse: boolean;
};

export type VerificationContext = {
  run: RunRecord;
  task: TaskManifest;
  agent: AgentConfig;
  plan: RunPlan;
  submission: SubmissionPackage;
  remainingMs(): number;
  runWithDeadline<T>(label: string, operation: () => Promise<T>): Promise<T>;
  acquireWithDeadline<T>(
    label: string,
    operation: () => Promise<T>,
    cleanup: (resource: T) => Promise<void>,
  ): Promise<T>;
  runWithCleanupGrace<T>(
    label: string,
    operation: () => Promise<T>,
  ): Promise<T>;
  onStage(
    stage: "provisioning" | "building" | "verifying" | "capturing",
  ): void;
};

export type VerificationResult = {
  score: ScoreBreakdown;
  evidence: Record<string, unknown>;
  logs: string[];
  cleanupIssues?: CleanupIssue[];
};

export interface VerifierRegistryPort {
  verify(context: VerificationContext): Promise<VerificationResult>;
}

export type OrchestratorDependencies = {
  repository: RunRepository;
  events: RunEventBus;
  providers: AgentProviderRegistry;
  credentials: CredentialStore;
  createToolBroker(input: {
    workspace: DisposableWorkspace;
    plan: RunPlan;
    sink: AgentEventSink;
    supervisor: ResourceSupervisor;
    remainingMs(): number;
  }): AgentToolBroker;
  verifier: VerifierRegistryPort;
  resolveSelection(request: RunRequest): Promise<RunSelection>;
  preflight(selection: RunSelection): Promise<void>;
  createWorkspace(runId: string): Promise<DisposableWorkspace>;
  packageSubmission(
    workspace: Pick<DisposableWorkspace, "root">,
  ): Promise<SubmissionPackage>;
  now?: () => number;
  cleanupGraceMs?: number;
};
