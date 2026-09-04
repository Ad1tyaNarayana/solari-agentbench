import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { CertificationService } from "@/core/certification/service";
import { BenchmarkLoader } from "@/core/benchmarks/loader";
import { EvaluatorRegistry } from "@/core/evaluators/registry";
import { createSolariServices } from "@/core/solari/clients";
import type { EvaluationEngineResult } from "@/core/evaluators/engine";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("validate-only loads, packages, and validates without provisioning or writing", async () => {
  const fixture = await certificationFixture();
  const evaluator = { run: vi.fn() };
  const service = serviceFor(fixture, evaluator, fakeServices());

  const result = await service.validate({
    benchmarkRoot: fixture.pack,
    submissionDirectory: fixture.submission,
  });

  expect(result).toMatchObject({
    valid: true,
    provisioned: false,
    benchmarkId: "cert-pack",
    taskId: "task",
  });
  expect(evaluator.run).not.toHaveBeenCalled();
  await expect(access(fixture.output)).rejects.toMatchObject({ code: "ENOENT" });
});

test("refuses to create a certificate with unbranded fake services", async () => {
  const fixture = await certificationFixture();
  const evaluator = { run: vi.fn() };
  const service = serviceFor(fixture, evaluator, fakeServices());

  await expect(service.certify({
    benchmarkRoot: fixture.pack,
    submissionDirectory: fixture.submission,
    outputPath: fixture.output,
  })).rejects.toThrow(/live Solari services/i);
  expect(evaluator.run).not.toHaveBeenCalled();
  await expect(access(fixture.output)).rejects.toMatchObject({ code: "ENOENT" });
});

test("writes a redacted certificate only after sandbox/browser use and clean disposal", async () => {
  const fixture = await certificationFixture();
  const services = createSolariServices("slr_test_example", "https://example.invalid");
  const evaluator = { run: vi.fn(async () => evaluationResult()) };
  const service = serviceFor(fixture, evaluator, services);
  try {
    const report = await service.certify({
      benchmarkRoot: fixture.pack,
      submissionDirectory: fixture.submission,
      outputPath: fixture.output,
    });

    expect(report).toMatchObject({ solariLive: true, repositoryCommit: "abc123" });
    expect(JSON.parse(await readFile(fixture.output, "utf8"))).toEqual(report);
    expect(await readFile(fixture.output, "utf8")).not.toContain("provider-secret");
  } finally {
    await services.dispose?.();
  }
});

test("reports redacted evaluator diagnostics when a certification score is invalid", async () => {
  const fixture = await certificationFixture();
  const services = createSolariServices("slr_test_example", "https://example.invalid");
  const failed = evaluationResult();
  failed.report = {
    ...failed.report,
    status: "invalid-score" as const,
    score: null,
    results: [
      {
        ...failed.report.results[0],
        evaluatorId: "verify-raft",
        status: "error" as const,
        earnedPoints: 0,
        summary: "sandbox unavailable",
      },
    ],
  };
  const service = serviceFor(fixture, { run: vi.fn(async () => failed) }, services);
  try {
    await expect(service.certify({
      benchmarkRoot: fixture.pack,
      submissionDirectory: fixture.submission,
      outputPath: fixture.output,
    })).rejects.toThrow(
      "Certification requires a valid evaluator score (verify-raft:error: sandbox unavailable)",
    );
  } finally {
    await services.dispose?.();
  }
});

test.each([
  ["missing browser", { browsers: [], sandboxes: ["s1"], desktops: [] }, []],
  ["missing sandbox", { browsers: ["b1"], sandboxes: [], desktops: [] }, []],
  ["cleanup failure", { browsers: ["b1"], sandboxes: ["s1"], desktops: [] }, [{ code: "cleanup_failed" as const, detail: "sandbox s1" }]],
])("does not write a certificate after %s", async (_label, created, cleanupIssues) => {
  const fixture = await certificationFixture();
  const services = createSolariServices("slr_test_example", "https://example.invalid");
  const evaluator = { run: vi.fn(async () => ({ ...evaluationResult(), resourceAudit: { created, cleanupIssues } })) };
  const service = serviceFor(fixture, evaluator, services);
  try {
    await expect(service.certify({
      benchmarkRoot: fixture.pack,
      submissionDirectory: fixture.submission,
      outputPath: fixture.output,
    })).rejects.toThrow(/browser|sandbox|cleanup/i);
    await expect(access(fixture.output)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await services.dispose?.();
  }
});

function evaluationResult(): EvaluationEngineResult {
  return {
    report: {
      status: "valid-score" as const,
      score: 100,
      possiblePoints: 100 as const,
      results: [{ evaluatorId: "result", status: "passed" as const, earnedPoints: 100, possiblePoints: 100, summary: "ok", assertions: [], evidence: [], outputs: { authorization: "Bearer provider-secret" }, metadata: {} }],
    },
    manifest: { schemaVersion: 1 as const, runId: "cert-run", taskId: "task", entries: [] },
    resourceAudit: { created: { browsers: ["b1"], sandboxes: ["s1"], desktops: [] }, cleanupIssues: [] },
  };
}

function fakeServices() {
  return { browser: {}, sandbox: {}, desktop: {} } as never;
}

function serviceFor(
  fixture: Awaited<ReturnType<typeof certificationFixture>>,
  evaluator: { run: ReturnType<typeof vi.fn> },
  services: ReturnType<typeof createSolariServices>,
) {
  const registry = new EvaluatorRegistry();
  registry.register("file", {
    type: "file",
    validate() {},
    async evaluate() { throw new Error("not used by certification service test"); },
  });
  return new CertificationService({
    loader: new BenchmarkLoader(fixture.snapshots),
    registry,
    evaluator: evaluator as never,
    services,
    repositoryCommit: "abc123",
    now: () => new Date("2026-09-04T00:00:00.000Z"),
  });
}

async function certificationFixture() {
  const root = await mkdtemp(join(tmpdir(), "agentbench-certification-"));
  roots.push(root);
  const pack = join(root, "pack");
  const snapshots = join(root, "snapshots");
  const submission = join(root, "candidate");
  const output = join(root, "certificate", "report.json");
  await mkdir(join(pack, "tasks", "task"), { recursive: true });
  await mkdir(submission);
  await writeFile(join(pack, "benchmark.yaml"), "schemaVersion: 1\nid: cert-pack\nname: Certification Pack\nversion: 1.0.0\ntaskRoots: [tasks]\ndefaults: { timeoutSeconds: 60, maxConcurrency: 1, submissionDirectory: submission }\n");
  await writeFile(join(pack, "agents.yaml"), "schemaVersion: 1\nagents:\n  - id: reference\n    name: Reference\n    provider: executable-jsonl\n    harness: { id: reference, version: '1' }\n");
  await writeFile(join(pack, "tasks", "task", "prompt.md"), "Produce results.json.\n");
  await writeFile(join(pack, "tasks", "task", "task.yaml"), "schemaVersion: 1\nid: task\nname: Task\nprompt: prompt.md\nfixtures: []\nresources:\n  allowed: [sandbox, browser]\n  planningRequired: true\n  budget: { browserSessions: 1, sandboxes: 1, desktops: 0, totalMinutes: 1 }\nsubmission: { directory: submission, required: [results.json] }\nevaluators:\n  - { id: result, type: file, weight: 100, config: { subject: results.json, assertion: present } }\n");
  await writeFile(join(submission, "results.json"), "{}");
  return { pack, snapshots, submission, output };
}
