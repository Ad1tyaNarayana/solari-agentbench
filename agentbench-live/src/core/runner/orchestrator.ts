import type { AgentDefinition, BenchmarkTaskDefinition } from "@/core/benchmarks/types";
import { redactCredentialOutput } from "@/core/credentials/redaction";
import type { RunPlan } from "@/core/domain/plan";
import type { FailureCode, RunRecord, RunStage } from "@/core/domain/run";
import { createAgentEventSink } from "@/core/providers/events";
import { AgentTimeoutError } from "@/core/providers/errors";
import type { AgentProvider, ProviderExecutionResult } from "@/core/providers/types";
import { redact } from "@/core/security/redact";
import type { DisposableWorkspace } from "@/core/security/workspace";
import { ResourceSupervisor } from "@/core/solari/resource-supervisor";
import { transition } from "./state-machine";
import { applyBudgetOutcome } from "./scoring";
import type { ScoreBreakdown } from "./scoring";
import type {
  CreatedRun,
  DryRunReport,
  OrchestratorDependencies,
  RunRequest,
  RunSelection,
} from "./contracts";

export class AgentBenchOrchestrator {
  private readonly activeRuns = new Map<string, AbortController>();
  constructor(private readonly dependencies: OrchestratorDependencies) {}

  cancel(id: string): RunRecord | undefined {
    const run = this.dependencies.repository.get(id);
    if (!run || run.stage === "completed" || run.stage === "failed" || run.stage === "cancelled") return run;
    const error = Object.assign(new Error("Run cancelled by operator"), { name: "AgentBenchCancelled" });
    const controller = this.activeRuns.get(id);
    if (controller) {
      controller.abort(error);
      const event = this.dependencies.repository.appendEvent(id, { kind: "warning", payload: { message: "Cancellation requested" } });
      this.dependencies.events.publish(id, event);
      return run;
    }
    const cancelled = this.dependencies.repository.update(id, { stage: transition(run.stage, "cancelled"), completedAt: new Date().toISOString() });
    const event = this.dependencies.repository.appendEvent(id, { kind: "stage", payload: { stage: "cancelled" } });
    this.dependencies.events.publish(id, event);
    return cancelled;
  }

  async dryRun(request: RunRequest): Promise<DryRunReport> {
    const selection = await this.dependencies.resolveSelection(request);
    const { task, agent } = selection;
    const { agentDefinition, taskDefinition, provider } =
      this.providerSelection(selection);
    await this.dependencies.preflight(selection);
    await provider.preflight({
      agent: agentDefinition,
      task: taskDefinition,
      snapshot: selection.snapshot,
    });
    const now = this.dependencies.now ?? Date.now;
    const deadlineAt = now() + task.budget.totalMs;
    const remainingMs = () => this.remainingMs(deadlineAt, now);
    const controller = new AbortController();
    const plan = await this.runWithDeadline("planning", remainingMs, () =>
      provider.plan({
        agent: agentDefinition,
        task: taskDefinition,
        snapshot: selection.snapshot,
        remainingMs,
      }, controller.signal),
    ).catch((error: unknown) => {
      controller.abort(error);
      throw error;
    });
    const description = provider.describe();
    return {
      taskId: task.id,
      agentId: agent.id,
      plan,
      budget: task.budget,
      requiredEvidence: task.requiredEvidence,
      estimatedMaximumMinutes: task.budget.totalMs / 60_000,
      provider: description.id,
      providerCapabilities: { ...description.capabilities },
      credentialConfigured: agentDefinition.credential === undefined
        ? true
        : await this.dependencies.credentials.has(agentDefinition.credential),
      plannedTools: [...plan.primitives],
      networkUse: description.id !== "codex",
    };
  }

  async run(request: RunRequest): Promise<RunRecord> {
    const created = await this.create(request);
    return this.runCreated(created.run.id, created.selection);
  }

  async create(request: RunRequest): Promise<CreatedRun> {
    const selection = await this.dependencies.resolveSelection(request);
    const { benchmark, snapshot, task, agent } = selection;
    if (request.benchmarkDigest && request.benchmarkDigest !== snapshot.digest) {
      throw Object.assign(new Error("Benchmark snapshot changed; reload before launching"), { code: "benchmark_conflict" });
    }
    const agentDefinition = benchmark.agents.find(
      (candidate) => candidate.id === agent.id,
    );
    if (
      task.id !== request.taskId ||
      agent.id !== request.agentId ||
      benchmark.id !== (request.benchmarkId ?? benchmark.id) ||
      !agentDefinition
    ) {
      throw new Error("Resolved selection does not match the run request");
    }
    const queued = this.dependencies.repository.create({
      taskId: task.id,
      taskVersion: task.version,
      agentId: agent.id,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
      benchmarkId: benchmark.id,
      benchmarkVersion: benchmark.version,
      benchmarkDigest: snapshot.digest,
      snapshotPath: snapshot.root,
      providerId: agentDefinition.provider,
      harnessId: agentDefinition.harness.id,
      harnessVersion: agentDefinition.harness.version,
    });
    return {
      run: this.move(queued, "loading"),
      selection,
    };
  }

  async runCreated(id: string, selection: RunSelection): Promise<RunRecord> {
    const { task, agent } = selection;
    const { agentDefinition, taskDefinition, provider } =
      this.providerSelection(selection);
    const created = this.requireRun(id);
    if (created.stage === "cancelled") return created;
    if (
      created.stage !== "loading" ||
      created.taskId !== task.id ||
      created.agentId !== agent.id ||
      created.benchmarkId !== selection.benchmark.id ||
      created.benchmarkDigest !== selection.snapshot.digest
    ) {
      throw new Error(`Run ${id} is not the matching loading run`);
    }
    const now = this.dependencies.now ?? Date.now;
    const runController = new AbortController();
    this.activeRuns.set(id, runController);
    const startedMs = now();
    const deadlineAt = startedMs + task.budget.totalMs;
    const cleanupGraceMs = this.dependencies.cleanupGraceMs ?? 10_000;
    const startedAt = new Date(startedMs).toISOString();
    const remainingMs = () => this.remainingMs(deadlineAt, now);
    const runWithDeadline = <T>(
      label: string,
      operation: () => Promise<T>,
    ) => this.runWithDeadline(label, remainingMs, operation);
    const runWithDeadlineSettled = <T>(
      label: string,
      operation: () => Promise<T>,
    ) => this.runWithDeadlineSettled(
      label,
      remainingMs,
      cleanupGraceMs,
      operation,
    );
    const runWithCleanupGrace = <T>(
      label: string,
      operation: () => Promise<T>,
    ) => this.runWithCleanupGrace(label, cleanupGraceMs, operation);
    let run = this.dependencies.repository.update(created.id, { startedAt });
    let workspace: DisposableWorkspace | undefined;
    const acquireWithDeadline = <T>(
      label: string,
      operation: () => Promise<T>,
      cleanup: (resource: T) => Promise<void>,
    ) => this.acquireWithDeadline(
      label,
      remainingMs,
      cleanupGraceMs,
      operation,
      cleanup,
      (detail) => this.recordCleanupIssue(run.id, detail),
    );

    try {
      run = this.move(run, "preflight");
      await runWithDeadline("preflight", async () => {
        await this.dependencies.preflight(selection);
        await provider.preflight({
          agent: agentDefinition,
          task: taskDefinition,
          snapshot: selection.snapshot,
        });
      });
      run = this.move(run, "planning");
      const planningController = new AbortController();
      const plan = await runWithDeadline("planning", () => provider.plan({
        agent: agentDefinition,
        task: taskDefinition,
        snapshot: selection.snapshot,
        remainingMs,
      }, AbortSignal.any([planningController.signal, runController.signal]))).catch((error: unknown) => {
        planningController.abort(error);
        throw error;
      });
      run = this.dependencies.repository.update(run.id, { runPlan: plan });

      workspace = await acquireWithDeadline(
        "workspace creation",
        () => this.dependencies.createWorkspace(run.id),
        (lateWorkspace) => lateWorkspace.dispose(),
      );
      run = this.move(run, "generating");
      const providerResult = await this.executeProvider({
        run,
        provider,
        agent: agentDefinition,
        task: taskDefinition,
        snapshot: selection.snapshot,
        plan,
        workspace,
        remainingMs,
        runWithCleanupGrace,
        signal: runController.signal,
      });
      run = this.dependencies.repository.update(run.id, {
        resolvedModel: providerResult.resolvedModel,
        providerOptions: redactCredentialOutput(agentDefinition.options) as Record<string, unknown>,
        toolPolicy: { primitives: plan.primitives },
        usage: providerResult.usage,
      });
      const submission = await runWithDeadline("submission packaging", () =>
        this.dependencies.packageSubmission(workspace!),
      );

      if (task.evaluators && this.dependencies.evaluator) {
        run = this.move(run, "provisioning");
        run = this.move(run, "building");
        run = this.move(run, "verifying");
        const evaluation = await runWithDeadlineSettled("evaluation", () =>
          this.dependencies.evaluator!.run({
            runId: run.id,
            taskId: task.id,
            definitions: task.evaluators!,
            snapshotPrefix: task.snapshotPrefix,
            submission,
            snapshot: selection.snapshot,
            remainingMs,
            signal: runController.signal,
          }),
        );
        run = this.move(run, "capturing");
        run = this.dependencies.repository.update(run.id, {
          evaluationStatus: evaluation.report.status,
          primaryScore: evaluation.report.score,
          evaluationReport: evaluation.report,
          evidenceManifest: evaluation.manifest,
          score: evaluation.report.score === null ? undefined : { total: evaluation.report.score },
          evidence: evaluation.manifest as unknown as Record<string, unknown>,
          sanitizedLogs: [],
        });
        if (evaluation.report.status === "invalid-score") {
          const hasEvaluatorError = evaluation.report.results.some((result) => result.status === "error");
          throw Object.assign(new Error(hasEvaluatorError ? "Evaluator pipeline reported an error" : "Evaluator score is invalid"), { code: hasEvaluatorError ? "evaluator_error" : "score_invalid" });
        }
        const durationMs = now() - startedMs;
        remainingMs();
        run = this.move(run, "completed", { completedAt: new Date(now()).toISOString(), durationMs });
      } else {
        if (!this.dependencies.verifier) throw new Error("No evaluator pipeline or compatibility verifier is configured");
        const verification = await runWithDeadlineSettled("verification", () =>
          this.dependencies.verifier!.verify({
          run,
          task,
          agent,
          plan,
          submission,
          remainingMs,
          runWithDeadline,
          acquireWithDeadline,
          runWithCleanupGrace,
          onStage: (stage) => {
            remainingMs();
            run = this.move(this.requireRun(run.id), stage);
          },
          }),
        );
        if (run.stage !== "verifying" && run.stage !== "capturing") {
          throw new Error(`Verifier ended before reporting real work stages (last stage: ${run.stage})`);
        }
        for (const issue of verification.cleanupIssues ?? []) this.recordCleanupIssue(run.id, issue.detail);
        run = this.requireRun(run.id);
        const durationMs = now() - startedMs;
        remainingMs();
        run = this.dependencies.repository.update(run.id, {
          score: applyBudgetOutcome(verification.score, durationMs <= task.budget.totalMs),
          evidence: verification.evidence,
          sanitizedLogs: verification.logs.map((line) => redact(line, { localRoots: workspace ? [workspace.root] : [] })),
        });
        run = this.move(run, "completed", { completedAt: new Date(now()).toISOString(), durationMs });
      }
    } catch (error) {
      run = this.fail(run, error, workspace, now() - startedMs, now);
    } finally {
      if (workspace) {
        try {
          await runWithCleanupGrace("workspace cleanup", () =>
            workspace!.dispose(),
          );
        } catch (error) {
          const detail = redact(
            error instanceof Error ? error.message : String(error),
            { localRoots: [workspace.root] },
          );
          const current = this.requireRun(run.id);
          run = this.dependencies.repository.update(run.id, {
            cleanupIssues: [
              ...(current.cleanupIssues ?? []),
              { code: "cleanup_failed", detail },
            ],
          });
          const event = this.dependencies.repository.appendEvent(run.id, {
            kind: "cleanup",
            payload: { code: "cleanup_failed", detail },
          });
          this.dependencies.events.publish(run.id, event);
        }
      }
    }

    this.activeRuns.delete(id);
    const finishedAtMs = now();
    const totalDurationMs = finishedAtMs - startedMs;
    const current = this.requireRun(run.id);
    run = this.dependencies.repository.update(run.id, {
      completedAt: new Date(finishedAtMs).toISOString(),
      durationMs: totalDurationMs,
      score: current.score && !current.evaluationReport
        ? applyBudgetOutcome(
            current.score as ScoreBreakdown,
            totalDurationMs <= task.budget.totalMs,
          )
        : undefined,
    });
    return run;
  }

  private move(
    run: RunRecord,
    stage: Exclude<RunStage, "failed">,
    patch: Partial<RunRecord> = {},
  ): RunRecord {
    const next = transition(run.stage, stage);
    const updated = this.dependencies.repository.update(run.id, {
      ...patch,
      stage: next,
      lastSuccessfulStage: run.stage === "queued" ? undefined : run.stage,
    });
    const event = this.dependencies.repository.appendEvent(run.id, {
      kind: "stage",
      payload: { stage },
    });
    this.dependencies.events.publish(run.id, event);
    return updated;
  }

  private fail(
    run: RunRecord,
    error: unknown,
    workspace?: DisposableWorkspace,
    durationMs?: number,
    now: () => number = Date.now,
  ): RunRecord {
    const detail = redact(error instanceof Error ? error.message : String(error), {
      localRoots: workspace ? [workspace.root] : [],
    });
    if (typeof error === "object" && error !== null && "name" in error && error.name === "AgentBenchCancelled") {
      const updated = this.dependencies.repository.update(run.id, { stage: transition(run.stage, "cancelled"), completedAt: new Date(now()).toISOString(), durationMs });
      const event = this.dependencies.repository.appendEvent(run.id, { kind: "stage", payload: { stage: "cancelled" } });
      this.dependencies.events.publish(run.id, event);
      return updated;
    }
    const failureCode = this.failureCode(error, run.stage);
    const updated = this.dependencies.repository.update(run.id, {
      stage: transition(run.stage, "failed"),
      failureCode,
      failureDetail: detail,
      completedAt: new Date(now()).toISOString(),
      durationMs,
    });
    const event = this.dependencies.repository.appendEvent(run.id, {
      kind: "stage",
      payload: { stage: "failed", failureCode },
    });
    this.dependencies.events.publish(run.id, event);
    return updated;
  }

  private failureCode(error: unknown, stage: RunStage): FailureCode {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      [
        "plan_invalid",
        "preflight_failed",
        "agent_timeout",
        "agent_failed",
        "submission_invalid",
        "provision_failed",
        "build_failed",
        "verification_failed",
        "evidence_failed",
        "cleanup_failed",
        "evaluator_error",
        "score_invalid",
      ].includes(error.code)
    ) {
      return error.code as FailureCode;
    }
    if (stage === "preflight") return "preflight_failed";
    if (error instanceof AgentTimeoutError) return "agent_timeout";
    if (stage === "generating") {
      return "agent_failed";
    }
    if (stage === "provisioning") return "provision_failed";
    if (stage === "building") return "build_failed";
    if (stage === "verifying") return "verification_failed";
    if (stage === "capturing") return "evidence_failed";
    return "submission_invalid";
  }

  private requireRun(id: string): RunRecord {
    const run = this.dependencies.repository.get(id);
    if (!run) throw new Error(`Run disappeared from repository: ${id}`);
    return run;
  }

  private providerSelection(selection: RunSelection): {
    agentDefinition: AgentDefinition;
    taskDefinition: BenchmarkTaskDefinition;
    provider: AgentProvider;
  } {
    const agentDefinition = selection.benchmark.agents.find(
      (candidate) => candidate.id === selection.agent.id,
    );
    const benchmarkTask = selection.benchmark.tasks.find(
      (candidate) => candidate.id === selection.task.id,
    );
    if (!agentDefinition || !benchmarkTask) {
      throw new Error("Resolved selection is missing its benchmark definitions");
    }
    const taskDefinition: BenchmarkTaskDefinition = {
      ...benchmarkTask,
      prompt: selection.task.prompt,
      allowedPrimitives: [...selection.task.allowedPrimitives],
    };
    return {
      agentDefinition,
      taskDefinition,
      provider: this.dependencies.providers.get(agentDefinition.provider),
    };
  }

  private async executeProvider(input: {
    run: RunRecord;
    provider: AgentProvider;
    agent: AgentDefinition;
    task: BenchmarkTaskDefinition;
    snapshot: RunSelection["snapshot"];
    plan: RunPlan;
    workspace: DisposableWorkspace;
    remainingMs(): number;
    runWithCleanupGrace<T>(label: string, operation: () => Promise<T>): Promise<T>;
    signal: AbortSignal;
  }): Promise<ProviderExecutionResult> {
    const supervisor = new ResourceSupervisor();
    const sink = createAgentEventSink({
      provider: input.provider.describe().id,
      redact: (value) => redact(value, { localRoots: [input.workspace.root] }),
      publish: (providerEvent) => {
        const event = this.dependencies.repository.appendEvent(input.run.id, {
          kind: "provider_event",
          payload: { ...providerEvent },
        });
        this.dependencies.events.publish(input.run.id, event);
      },
    });
    const tools = this.dependencies.createToolBroker({
      workspace: input.workspace,
      plan: input.plan,
      sink,
      supervisor,
      remainingMs: input.remainingMs,
    });
    const controller = new AbortController();
    const abort = () => controller.abort(input.signal.reason);
    if (input.signal.aborted) abort(); else input.signal.addEventListener("abort", abort, { once: true });
    let execution: Awaited<ReturnType<AgentProvider["execute"]>> | undefined;
    try {
      execution = await this.abortable(input.provider.execute({
        agent: input.agent,
        task: input.task,
        snapshot: input.snapshot,
        plan: input.plan,
        workspace: input.workspace,
        tools,
        remainingMs: input.remainingMs,
      }, sink, controller.signal), controller.signal);
      return await this.runWithDeadline(
        "provider execution",
        input.remainingMs,
        () => this.abortable(execution!.result, controller.signal),
      );
    } catch (error) {
      controller.abort(error);
      if (execution) {
        try {
          await input.runWithCleanupGrace(
            "provider cancellation",
            () => input.provider.cancel(execution!.handle),
          );
        } catch (cancelError) {
          this.recordCleanupIssue(
            input.run.id,
            `provider cancellation: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`,
          );
        }
      }
      throw error;
    } finally {
      input.signal.removeEventListener("abort", abort);
      sink.close();
      try {
        for (const issue of await input.runWithCleanupGrace(
          "provider resource cleanup",
          () => supervisor.cleanup(),
        )) {
          this.recordCleanupIssue(input.run.id, issue.detail);
        }
      } catch (cleanupError) {
        this.recordCleanupIssue(
          input.run.id,
          `provider resource cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
    }
  }

  private abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason ?? Object.assign(new Error("Operation aborted"), { name: "AbortError" }));
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason ?? Object.assign(new Error("Operation aborted"), { name: "AbortError" }));
      signal.addEventListener("abort", abort, { once: true });
      operation.then(
        (value) => { signal.removeEventListener("abort", abort); resolve(value); },
        (error) => { signal.removeEventListener("abort", abort); reject(error); },
      );
    });
  }

  private remainingMs(deadlineAt: number, now: () => number): number {
    const remaining = Math.ceil(deadlineAt - now());
    if (remaining <= 0) {
      throw new AgentTimeoutError("Total run deadline exceeded");
    }
    return remaining;
  }

  private async runWithDeadline<T>(
    label: string,
    remainingMs: () => number,
    operation: () => Promise<T>,
  ): Promise<T> {
    const timeoutMs = remainingMs();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new AgentTimeoutError(`Total run deadline exceeded during ${label}`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async runWithDeadlineSettled<T>(
    label: string,
    remainingMs: () => number,
    cleanupGraceMs: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    const pending = Promise.resolve().then(operation);
    try {
      return await this.runWithDeadline(label, remainingMs, () => pending);
    } catch (error) {
      if (error instanceof AgentTimeoutError) {
        try {
          await this.runWithCleanupGrace(
            `${label} settlement`,
            cleanupGraceMs,
            () => pending.then(() => undefined, () => undefined),
          );
        } catch {
          // The caller still performs independent inventory and cleanup below.
        }
      }
      throw error;
    }
  }

  private async acquireWithDeadline<T>(
    label: string,
    remainingMs: () => number,
    cleanupGraceMs: number,
    operation: () => Promise<T>,
    cleanup: (resource: T) => Promise<void>,
    onCleanupIssue: (detail: string) => void,
  ): Promise<T> {
    const pending = Promise.resolve().then(operation);
    let timedOut = false;
    let cleanupPromise: Promise<void> | undefined;
    const cleanupOnce = (resource: T) => {
      cleanupPromise ??= Promise.resolve().then(() => cleanup(resource));
      return cleanupPromise;
    };
    const lateCleanup = pending.then(
      async (resource) => {
        if (!timedOut) return;
        try {
          await cleanupOnce(resource);
        } catch (error) {
          onCleanupIssue(
            `late ${label} cleanup: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
      () => undefined,
    );

    try {
      return await this.runWithDeadline(label, remainingMs, () => pending);
    } catch (error) {
      if (!(error instanceof AgentTimeoutError)) throw error;
      timedOut = true;
      try {
        await this.runWithCleanupGrace(
          `late ${label} cleanup`,
          cleanupGraceMs,
          () => lateCleanup,
        );
      } catch (cleanupError) {
        onCleanupIssue(
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
        );
      }
      throw error;
    }
  }

  private async runWithCleanupGrace<T>(
    label: string,
    cleanupGraceMs: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Cleanup grace expired during ${label}`)),
            Math.max(1, cleanupGraceMs),
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private recordCleanupIssue(runId: string, detail: string): void {
    const current = this.requireRun(runId);
    this.dependencies.repository.update(runId, {
      cleanupIssues: [
        ...(current.cleanupIssues ?? []),
        { code: "cleanup_failed", detail },
      ],
    });
    const event = this.dependencies.repository.appendEvent(runId, {
      kind: "cleanup",
      payload: { code: "cleanup_failed", detail },
    });
    this.dependencies.events.publish(runId, event);
  }
}
