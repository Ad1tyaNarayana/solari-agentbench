import type { BenchmarkSnapshot } from "@/core/benchmarks/snapshot";
import type { EvaluatorDefinition } from "@/core/benchmarks/types";
import type { CredentialStore } from "@/core/credentials/types";
import type { EvidenceReference, EvidenceWriter } from "@/core/evidence/types";
import type { AgentProviderRegistry } from "@/core/providers/registry";
import type { SubmissionPackage } from "@/core/security/package-submission";
import type { BrowserHandle, DesktopHandle, SandboxHandle } from "@/core/solari/contracts";

export type EvaluatorStatus = "passed" | "failed" | "error" | "skipped";
export type EvaluatorAssertion = { id: string; passed: boolean; summary: string; expected?: unknown; observed?: unknown };
export type EvaluatorResult = {
  evaluatorId: string;
  status: EvaluatorStatus;
  earnedPoints: number;
  possiblePoints: number;
  summary: string;
  assertions: EvaluatorAssertion[];
  evidence: EvidenceReference[];
  outputs: Record<string, unknown>;
  metadata: Record<string, unknown>;
};
export type EvaluationReport = { status: "valid-score" | "invalid-score"; score: number | null; possiblePoints: 100; results: EvaluatorResult[] };

export interface EvaluatorResourcePort {
  acquireSandbox(label: string, options?: { timeoutMs?: number }): Promise<SandboxHandle>;
  acquireBrowser(label: string, options?: { recording?: boolean }): Promise<BrowserHandle>;
  acquireDesktop(label: string, options?: { timeoutMs?: number }): Promise<DesktopHandle>;
  publishOutputs(evaluatorId: string, outputs: Record<string, unknown>): void;
  getOutput(evaluatorId: string, key: string): unknown;
  dispose(): Promise<void>;
}

export type EvaluatorContext = {
  runId: string;
  taskId: string;
  submission: SubmissionPackage;
  snapshot: BenchmarkSnapshot;
  evidence: EvidenceWriter;
  resources: EvaluatorResourcePort;
  providers: AgentProviderRegistry;
  credentials: CredentialStore;
  remainingMs(): number;
};

export type EvaluatorOutcome = Omit<EvaluatorResult, "evaluatorId" | "possiblePoints" | "earnedPoints"> & { earnedFraction: number };
export interface Evaluator {
  readonly type: EvaluatorDefinition["type"];
  validate(definition: EvaluatorDefinition): void;
  evaluate(definition: EvaluatorDefinition, context: EvaluatorContext, signal: AbortSignal): Promise<EvaluatorOutcome>;
}
