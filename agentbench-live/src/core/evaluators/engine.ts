import type { BenchmarkSnapshot } from "@/core/benchmarks/snapshot";
import type { EvaluatorDefinition } from "@/core/benchmarks/types";
import type { CredentialStore } from "@/core/credentials/types";
import { EvidenceStore } from "@/core/evidence/store";
import type { EvidenceManifest } from "@/core/evidence/manifest";
import type { AgentProviderRegistry } from "@/core/providers/registry";
import type { SubmissionPackage } from "@/core/security/package-submission";
import type { SolariServices } from "@/core/solari/contracts";
import { EvaluatorPipeline } from "./pipeline";
import type { EvaluatorRegistry } from "./registry";
import { EvaluatorRuntime } from "./runtime";
import type { EvaluationResourceAudit } from "./runtime";
import type { EvaluationReport } from "./types";

export type EvaluationEngineResult = { report: EvaluationReport; manifest: EvidenceManifest; resourceAudit: EvaluationResourceAudit };
export type EvaluationEngineInput = { runId: string; taskId: string; definitions: EvaluatorDefinition[]; snapshotPrefix?: string; submission: SubmissionPackage; snapshot: BenchmarkSnapshot; remainingMs(): number; signal?: AbortSignal };
export interface EvaluationEnginePort { run(input: EvaluationEngineInput): Promise<EvaluationEngineResult> }

export class EvaluationEngine implements EvaluationEnginePort {
  constructor(private readonly dependencies: { registry: EvaluatorRegistry; services: SolariServices; providers: AgentProviderRegistry; credentials: CredentialStore; evidenceRoot: string }) {}
  async run(input: EvaluationEngineInput): Promise<EvaluationEngineResult> {
    const runtime = new EvaluatorRuntime(this.dependencies.services);
    const evidence = new EvidenceStore({ root: this.dependencies.evidenceRoot, runId: input.runId, taskId: input.taskId });
    let report: EvaluationReport;
    let resourceAudit: EvaluationResourceAudit;
    try {
      const definitions = input.definitions.map((definition) => {
        const config = { ...definition.config };
        if (input.snapshotPrefix && definition.type === "schema" && typeof config.schema === "string") config.schema = `${input.snapshotPrefix}/${config.schema}`;
        if (input.snapshotPrefix && definition.type === "model-judge" && typeof config.rubric === "string") config.rubric = `${input.snapshotPrefix}/${config.rubric}`;
        return { ...definition, prerequisites: [...definition.prerequisites], config };
      });
      report = await new EvaluatorPipeline(this.dependencies.registry).run({ runId: input.runId, taskId: input.taskId, submission: input.submission, snapshot: input.snapshot, evidence, resources: runtime, providers: this.dependencies.providers, credentials: this.dependencies.credentials, remainingMs: input.remainingMs }, definitions, input.signal);
    } finally {
      resourceAudit = await runtime.disposeWithAudit();
    }
    return { report, manifest: await evidence.readManifest(), resourceAudit };
  }
}
