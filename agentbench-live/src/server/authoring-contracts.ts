import type { AgentProviderDescription } from "@/core/providers/types";
import type { CredentialMetadata } from "@/core/credentials/types";
import type { AuthoringRevision, BenchmarkDraft, PreviewResult, ReadDraftResult } from "@/core/authoring/types";

export interface StudioApiPort {
  listBenchmarks(): Promise<Array<{ id: string; name: string; version: string; writable: boolean }>>;
  readBenchmark(id: string): Promise<ReadDraftResult>;
  previewBenchmark(draft: BenchmarkDraft): Promise<PreviewResult>;
  createBenchmark(input: { draft: BenchmarkDraft }): Promise<ReadDraftResult>;
  saveBenchmark(input: { packId: string; expectedRevision: AuthoringRevision; draft: BenchmarkDraft }): Promise<ReadDraftResult>;
  listProviders(): AgentProviderDescription[];
  listCredentials(): Promise<CredentialMetadata[]>;
}
