export type EvaluatorType =
  | "file" | "schema" | "command" | "http"
  | "browser" | "numeric" | "model-judge";

export type EvaluatorDefinition = {
  id: string;
  type: EvaluatorType;
  weight: number;
  enabled: boolean;
  prerequisites: string[];
  config: Record<string, unknown>;
};

export type BenchmarkTaskDefinition = {
  id: string;
  name: string;
  promptPath: string;
  prompt: string;
  fixtures: string[];
  allowedPrimitives: Array<"browser" | "sandbox" | "desktop">;
  planningRequired: boolean;
  resourceLimits: { browserSessions: number; sandboxes: number; desktops: number; totalMinutes: number };
  submission: { directory: string; required: string[] };
  compatibility?: {
    requiredEvidence: Array<"browser" | "sandbox" | "desktop">;
    legacyVerifier: string;
    legacyBudgetMs: { totalMs: number; browserMs: number; sandboxMs: number; desktopMs: number };
  };
  evaluators: EvaluatorDefinition[];
};

export type AgentDefinition = {
  id: string; name: string; provider: string; model?: string; reasoningEffort?: string; credential?: string;
  harness: { id: string; version: string }; options: Record<string, unknown>;
};

export type BenchmarkDefinition = {
  schemaVersion: 1; id: string; name: string; version: string; description?: string; root: string;
  defaults: { timeoutSeconds: number; maxConcurrency: number; submissionDirectory: string };
  tasks: BenchmarkTaskDefinition[]; agents: AgentDefinition[];
};

export type BenchmarkDiagnostic = { path: string; code: string; message: string };

export class BenchmarkValidationError extends Error {
  readonly diagnostics: BenchmarkDiagnostic[];
  constructor(diagnostics: BenchmarkDiagnostic[]) {
    super(diagnostics.map((d) => `${d.path}: ${d.message}`).join("; ") || "Invalid benchmark file");
    this.name = "BenchmarkValidationError";
    this.diagnostics = diagnostics;
  }
}
