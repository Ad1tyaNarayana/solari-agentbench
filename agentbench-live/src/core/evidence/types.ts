export type EvidenceReference = {
  digest: string;
  size: number;
  mimeType: string;
  role: string;
  producer: "agent" | "provider" | "orchestrator" | "evaluator";
  runId: string;
  taskId: string;
  evaluatorId?: string;
  createdAt: string;
  redacted: boolean;
  external?: { url: string; expiresAt?: string };
};

export type EvidenceWriteBase = Pick<EvidenceReference, "mimeType" | "role" | "producer" | "evaluatorId">;

export interface EvidenceWriter {
  putBytes(input: EvidenceWriteBase & { bytes: Uint8Array }): Promise<EvidenceReference>;
  putText(input: EvidenceWriteBase & { text: string }): Promise<EvidenceReference>;
  putJson(input: EvidenceWriteBase & { value: unknown }): Promise<EvidenceReference>;
}
