import type { AgentDefinition, BenchmarkDiagnostic, BenchmarkTaskDefinition } from "@/core/benchmarks/types";

export type BenchmarkDraftTask = Omit<BenchmarkTaskDefinition, "promptPath" | "prompt" | "compatibility" | "snapshotPrefix"> & { prompt: string };
export type BenchmarkDraft = {
  schemaVersion: 1; id: string; name: string; version: string; description?: string;
  defaults: { timeoutSeconds: number; maxConcurrency: number; submissionDirectory: string };
  tasks: BenchmarkDraftTask[]; agents: AgentDefinition[];
};
export type RenderedBenchmarkFile = { path: string; contents: string; language: "yaml" | "markdown" | "json" | "text" };
export type AuthoringRevision = Record<string, string>;
export type ReadDraftResult = { draft: BenchmarkDraft; revision: AuthoringRevision; snapshotDigest: string };
export type PreviewResult = { files: RenderedBenchmarkFile[]; diagnostics: BenchmarkDiagnostic[]; snapshotDigest: string };

export class AuthoringError extends Error {
  constructor(readonly code: "benchmark_invalid" | "benchmark_not_found" | "benchmark_conflict" | "benchmark_read_only", message: string, readonly changedPaths?: string[], readonly diagnostics?: BenchmarkDiagnostic[]) { super(message); this.name = "AuthoringError"; }
}
