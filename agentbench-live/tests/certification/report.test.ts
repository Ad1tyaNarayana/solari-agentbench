import { expect, test } from "vitest";
import { buildCertificationReport } from "@/core/certification/report";

test("builds a canonical redacted live reference certificate", () => {
  const report = buildCertificationReport({
    benchmark: { id: "raft", version: "1.0.0", digest: "bench-digest" },
    task: {
      id: "raft-safety",
      allowedPrimitives: ["sandbox", "browser"],
      resourceLimits: { browserSessions: 1, sandboxes: 1, desktops: 0, totalMinutes: 5 },
      evaluators: [{ id: "verify", type: "command", weight: 100, enabled: true, prerequisites: [], config: { network: false } }],
    },
    submissionDigest: "submission-digest",
    evaluation: {
      report: {
        status: "valid-score",
        score: 100,
        possiblePoints: 100,
        results: [{ evaluatorId: "verify", status: "passed", earnedPoints: 100, possiblePoints: 100, summary: "ok", assertions: [], evidence: [], outputs: { token: "certificate-secret" }, metadata: {} }],
      },
      manifest: { schemaVersion: 1, runId: "cert-run", taskId: "raft-safety", entries: [] },
      resourceAudit: { created: { browsers: ["browser-1"], sandboxes: ["sandbox-1"], desktops: [] }, cleanupIssues: [] },
    },
    repositoryCommit: "abc123",
    createdAt: "2026-09-04T00:00:00.000Z",
  });

  expect(Object.keys(report)).toEqual([
    "schemaVersion", "mode", "benchmark", "taskId", "agentId", "provider",
    "harness", "submissionDigest", "evaluators", "evaluation", "resourcePolicy",
    "networkPolicy", "resourceAudit", "evidenceDigests", "solariLive",
    "createdAt", "repositoryCommit",
  ]);
  expect(report).toMatchObject({
    schemaVersion: 1,
    mode: "live-reference-certification",
    agentId: null,
    provider: null,
    harness: null,
    solariLive: true,
    evaluators: [{ id: "verify", type: "command", version: 1, weight: 100 }],
  });
  expect(JSON.stringify(report)).not.toContain("certificate-secret");
  expect(report.evaluation.results[0].outputs).toEqual({ token: "[REDACTED]" });
});
