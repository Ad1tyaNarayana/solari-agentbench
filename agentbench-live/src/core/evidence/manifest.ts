import type { EvidenceReference } from "./types";

export type EvidenceManifest = {
  schemaVersion: 1;
  runId: string;
  taskId: string;
  entries: EvidenceReference[];
};

export function sortEvidence(entries: EvidenceReference[]): EvidenceReference[] {
  return [...entries].sort((left, right) => left.digest.localeCompare(right.digest) || left.role.localeCompare(right.role));
}
