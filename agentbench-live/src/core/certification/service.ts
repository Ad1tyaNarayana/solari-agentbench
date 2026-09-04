import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { BenchmarkLoader, LoadedBenchmark } from "@/core/benchmarks/loader";
import type { BenchmarkTaskDefinition } from "@/core/benchmarks/types";
import type { EvaluationEnginePort, EvaluationEngineResult } from "@/core/evaluators/engine";
import type { EvaluatorRegistry } from "@/core/evaluators/registry";
import { defaultSubmissionPolicy, packageSubmissionDirectory, type SubmissionPackage } from "@/core/security/package-submission";
import { isLiveSolariServices } from "@/core/solari/clients";
import type { SolariServices } from "@/core/solari/contracts";
import { buildCertificationReport } from "./report";
import type { CertificationInput, CertificationReport, CertificationValidation, CertificationWriteInput } from "./types";

type CertificationDependencies = {
  loader: BenchmarkLoader;
  registry: EvaluatorRegistry;
  evaluator: EvaluationEnginePort;
  services: SolariServices;
  repositoryCommit: string;
  now?: () => Date;
};

type PreparedCertification = {
  loaded: LoadedBenchmark;
  task: BenchmarkTaskDefinition;
  submission: SubmissionPackage;
};

export class CertificationService {
  private readonly now: () => Date;

  constructor(private readonly dependencies: CertificationDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async validate(input: CertificationInput): Promise<CertificationValidation> {
    const prepared = await this.prepare(input);
    return {
      valid: true,
      provisioned: false,
      benchmarkId: prepared.loaded.definition.id,
      benchmarkVersion: prepared.loaded.definition.version,
      benchmarkDigest: prepared.loaded.snapshot.digest,
      taskId: prepared.task.id,
      submissionDigest: prepared.submission.digest,
    };
  }

  async certify(input: CertificationWriteInput): Promise<CertificationReport> {
    if (!isLiveSolariServices(this.dependencies.services)) {
      throw new Error("Live Solari services are required to create a certification");
    }
    const prepared = await this.prepare(input);
    const timeoutMs = prepared.task.resourceLimits.totalMinutes * 60_000;
    const deadline = Date.now() + timeoutMs;
    const evaluation = await this.dependencies.evaluator.run({
      runId: `cert-${randomUUID()}`,
      taskId: prepared.task.id,
      definitions: prepared.task.evaluators,
      snapshotPrefix: prepared.task.snapshotPrefix,
      submission: prepared.submission,
      snapshot: prepared.loaded.snapshot,
      remainingMs: () => Math.max(1, deadline - Date.now()),
    });
    this.assertCertifiable(evaluation);
    const report = buildCertificationReport({
      benchmark: {
        id: prepared.loaded.definition.id,
        version: prepared.loaded.definition.version,
        digest: prepared.loaded.snapshot.digest,
      },
      task: prepared.task,
      submissionDigest: prepared.submission.digest,
      evaluation,
      repositoryCommit: this.dependencies.repositoryCommit,
      createdAt: this.now().toISOString(),
    });
    await atomicWriteJson(input.outputPath, report);
    return report;
  }

  private async prepare(input: CertificationInput): Promise<PreparedCertification> {
    const loaded = await this.dependencies.loader.load(input.benchmarkRoot);
    const task = selectTask(loaded, input.taskId);
    for (const definition of task.evaluators.filter((item) => item.enabled)) {
      this.dependencies.registry.get(definition.type).validate(definition);
    }
    const submission = await packageSubmissionDirectory(
      input.submissionDirectory,
      defaultSubmissionPolicy,
    );
    return { loaded, task, submission };
  }

  private assertCertifiable(evaluation: EvaluationEngineResult): void {
    if (evaluation.report.status !== "valid-score" || evaluation.report.score === null) {
      throw new Error("Certification requires a valid evaluator score");
    }
    if (evaluation.resourceAudit.created.sandboxes.length === 0) {
      throw new Error("Certification requires observed live Solari sandbox creation");
    }
    if (evaluation.resourceAudit.created.browsers.length === 0) {
      throw new Error("Certification requires observed live Solari browser creation");
    }
    if (evaluation.resourceAudit.cleanupIssues.length > 0) {
      throw new Error("Certification requires successful Solari resource cleanup");
    }
  }
}

function selectTask(loaded: LoadedBenchmark, taskId: string | undefined): BenchmarkTaskDefinition {
  if (taskId) {
    const selected = loaded.definition.tasks.find((task) => task.id === taskId);
    if (!selected) throw new Error(`Unknown certification task: ${taskId}`);
    return selected;
  }
  if (loaded.definition.tasks.length !== 1) {
    throw new Error("--task is required when a certification pack contains multiple tasks");
  }
  return loaded.definition.tasks[0];
}

async function atomicWriteJson(path: string, report: CertificationReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
