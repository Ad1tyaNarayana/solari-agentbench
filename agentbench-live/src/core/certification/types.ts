import type { EvaluationReport } from "@/core/evaluators/types";
import type { EvaluationResourceAudit } from "@/core/evaluators/runtime";

export type CertificationInput = {
  benchmarkRoot: string;
  submissionDirectory: string;
  taskId?: string;
};

export type CertificationWriteInput = CertificationInput & {
  outputPath: string;
};

export type CertificationValidation = {
  valid: true;
  provisioned: false;
  benchmarkId: string;
  benchmarkVersion: string;
  benchmarkDigest: string;
  taskId: string;
  submissionDigest: string;
};

export type CertificationReport = {
  schemaVersion: 1;
  mode: "live-reference-certification";
  benchmark: { id: string; version: string; digest: string };
  taskId: string;
  agentId: null;
  provider: null;
  harness: null;
  submissionDigest: string;
  evaluators: Array<{ id: string; type: string; version: 1; weight: number }>;
  evaluation: EvaluationReport;
  resourcePolicy: {
    allowedPrimitives: string[];
    limits: { browserSessions: number; sandboxes: number; desktops: number; totalMinutes: number };
  };
  networkPolicy: Array<{ evaluatorId: string; enabled: boolean }>;
  resourceAudit: EvaluationResourceAudit;
  evidenceDigests: string[];
  solariLive: true;
  createdAt: string;
  repositoryCommit: string;
};
