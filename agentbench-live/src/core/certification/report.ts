import type { BenchmarkTaskDefinition } from "@/core/benchmarks/types";
import type { EvaluationEngineResult } from "@/core/evaluators/engine";
import { redactCredentialOutput } from "@/core/credentials/redaction";
import type { CertificationReport } from "./types";

type ReportInput = {
  benchmark: { id: string; version: string; digest: string };
  task: Pick<BenchmarkTaskDefinition, "id" | "allowedPrimitives" | "resourceLimits" | "evaluators">;
  submissionDigest: string;
  evaluation: EvaluationEngineResult;
  repositoryCommit: string;
  createdAt: string;
};

export function buildCertificationReport(input: ReportInput): CertificationReport {
  const sanitizedEvaluation = redactCredentialOutput(input.evaluation.report) as CertificationReport["evaluation"];
  return {
    schemaVersion: 1,
    mode: "live-reference-certification",
    benchmark: { ...input.benchmark },
    taskId: input.task.id,
    agentId: null,
    provider: null,
    harness: null,
    submissionDigest: input.submissionDigest,
    evaluators: input.task.evaluators
      .filter((item) => item.enabled)
      .map((item) => ({ id: item.id, type: item.type, version: 1 as const, weight: item.weight })),
    evaluation: sanitizedEvaluation,
    resourcePolicy: {
      allowedPrimitives: [...input.task.allowedPrimitives],
      limits: { ...input.task.resourceLimits },
    },
    networkPolicy: input.task.evaluators
      .filter((item) => item.enabled && item.type === "command")
      .map((item) => ({ evaluatorId: item.id, enabled: item.config.network === true })),
    resourceAudit: {
      created: {
        browsers: [...input.evaluation.resourceAudit.created.browsers],
        sandboxes: [...input.evaluation.resourceAudit.created.sandboxes],
        desktops: [...input.evaluation.resourceAudit.created.desktops],
      },
      cleanupIssues: [...input.evaluation.resourceAudit.cleanupIssues],
    },
    evidenceDigests: [...new Set(input.evaluation.manifest.entries.map((item) => item.digest))].sort(),
    solariLive: true,
    createdAt: input.createdAt,
    repositoryCommit: input.repositoryCommit,
  };
}
