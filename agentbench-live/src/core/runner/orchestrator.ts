import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  AgentProcessError,
  AgentTimeoutError,
  PlanInvalidError,
} from "@/core/agents/codex-planner";
import type { RunPlan } from "@/core/domain/plan";
import type { FailureCode, RunRecord, RunStage } from "@/core/domain/run";
import type { AgentConfig } from "@/core/domain/run";
import type { TaskManifest } from "@/core/domain/task";
import { redact } from "@/core/security/redact";
import type { DisposableWorkspace } from "@/core/security/workspace";
import {
  auditGeneratedResources,
  captureInventory,
  ResourceSupervisor,
  trackGeneratedResources,
} from "@/core/solari/resource-supervisor";
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
  constructor(private readonly dependencies: OrchestratorDependencies) {}

  async dryRun(request: RunRequest): Promise<DryRunReport> {
    const selection = await this.dependencies.resolveSelection(request);
    const { task, agent } = selection;
    await this.dependencies.preflight(selection);
    const now = this.dependencies.now ?? Date.now;
    const deadlineAt = now() + task.budget.totalMs;
    const remainingMs = () => this.remainingMs(deadlineAt, now);
    const plan = await this.runWithDeadline(
      "planning",
      remainingMs,
      () => this.plan(`dry-${now()}`, task, agent, remainingMs),
    );
    return {
      taskId: task.id,
      agentId: agent.id,
      plan,
      budget: task.budget,
      requiredEvidence: task.requiredEvidence,
      estimatedMaximumMinutes: task.budget.totalMs / 60_000,
    };
  }

  async run(request: RunRequest): Promise<RunRecord> {
    const created = await this.create(request);
    return this.runCreated(created.run.id, created.selection);
  }

  async create(request: RunRequest): Promise<CreatedRun> {
    const selection = await this.dependencies.resolveSelection(request);
    const { benchmark, snapshot, task, agent } = selection;
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
    const created = this.requireRun(id);
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
      await runWithDeadline("preflight", () =>
        this.dependencies.preflight(selection),
      );
      run = this.move(run, "planning");
      const plan = await runWithDeadline("planning", () =>
        this.plan(run.id, task, agent, remainingMs),
      );
      run = this.dependencies.repository.update(run.id, { runPlan: plan });

      workspace = await acquireWithDeadline(
        "workspace creation",
        () => this.dependencies.createWorkspace(run.id),
        (lateWorkspace) => lateWorkspace.dispose(),
      );
      run = this.move(run, "generating");
      await this.generate(run, {
        agent,
        plan,
        taskPrompt: task.prompt,
        workspace,
        solariApiKey: this.dependencies.solariApiKey,
        timeoutMs: remainingMs(),
      }, remainingMs, runWithCleanupGrace);
      const submission = await runWithDeadline("submission packaging", () =>
        this.dependencies.packageSubmission(workspace!),
      );

      const verification = await runWithDeadlineSettled("verification", () =>
        this.dependencies.verifier.verify({
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
        throw new Error(
          `Verifier ended before reporting real work stages (last stage: ${run.stage})`,
        );
      }
      for (const issue of verification.cleanupIssues ?? []) {
        this.recordCleanupIssue(run.id, issue.detail);
      }
      run = this.requireRun(run.id);
      const durationMs = now() - startedMs;
      remainingMs();
      run = this.dependencies.repository.update(run.id, {
        score: applyBudgetOutcome(
          verification.score,
          durationMs <= task.budget.totalMs,
        ),
        evidence: verification.evidence,
        sanitizedLogs: verification.logs.map((line) =>
          redact(line, { localRoots: workspace ? [workspace.root] : [] }),
        ),
      });
      run = this.move(run, "completed", {
        completedAt: new Date(now()).toISOString(),
        durationMs,
      });
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

    const finishedAtMs = now();
    const totalDurationMs = finishedAtMs - startedMs;
    const current = this.requireRun(run.id);
    run = this.dependencies.repository.update(run.id, {
      completedAt: new Date(finishedAtMs).toISOString(),
      durationMs: totalDurationMs,
      score: current.score
        ? applyBudgetOutcome(
            current.score as ScoreBreakdown,
            totalDurationMs <= task.budget.totalMs,
          )
        : undefined,
    });
    return run;
  }

  private async plan(
    runId: string,
    task: TaskManifest,
    agent: AgentConfig,
    remainingMs: () => number,
  ): Promise<RunPlan> {
    const temporaryRoot = await realpath(tmpdir());
    const directory = await mkdtemp(join(temporaryRoot, "agentbench-plan-"));
    try {
      return await this.dependencies.planner.plan({
        agent,
        task,
        schemaPath: this.dependencies.schemaPath,
        outputPath: join(directory, `${runId}.json`),
        plannerPrompt: [
          `Choose the Solari primitives for task ${task.id}.`,
          `Allowed primitives: ${task.allowedPrimitives.join(", ")}.`,
          `Required verifier evidence: ${task.requiredEvidence.join(", ")}.`,
          "Explain every selected primitive and state the verification strategy.",
        ].join("\n"),
        timeoutMs: Math.min(remainingMs(), 120_000),
      });
    } finally {
      const resolved = await realpath(directory);
      if (
        dirname(resolved) !== temporaryRoot ||
        !basename(resolved).startsWith("agentbench-plan-")
      ) {
        throw new Error(`Refusing to remove unsafe plan directory: ${resolved}`);
      }
      await rm(resolved, { recursive: true, force: false });
    }
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
      ].includes(error.code)
    ) {
      return error.code as FailureCode;
    }
    if (error instanceof PlanInvalidError) return "plan_invalid";
    if (stage === "preflight") return "preflight_failed";
    if (error instanceof AgentTimeoutError) return "agent_timeout";
    if (error instanceof AgentProcessError || stage === "generating") {
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

  private async generate(
    run: RunRecord,
    input: Parameters<OrchestratorDependencies["generator"]["generate"]>[0],
    remainingMs: () => number,
    runWithCleanupGrace: <T>(
      label: string,
      operation: () => Promise<T>,
    ) => Promise<T>,
  ): Promise<void> {
    const resources = this.dependencies.generationResources;
    if (!resources) {
      await this.dependencies.generator.generate({
        ...input,
        timeoutMs: remainingMs(),
      });
      return;
    }

    const before = await this.runWithDeadline(
      "pre-generation resource inventory",
      remainingMs,
      () => captureInventory(resources.services),
    );
    let generationEvents: Awaited<
      ReturnType<OrchestratorDependencies["generator"]["generate"]>
    >["events"] = [];
    let primaryError: unknown;
    try {
      generationEvents = (
        await this.dependencies.generator.generate({
          ...input,
          timeoutMs: remainingMs(),
        })
      ).events;
    } catch (error) {
      primaryError = error;
      if (
        typeof error === "object" &&
        error !== null &&
        "events" in error &&
        Array.isArray(error.events)
      ) {
        generationEvents = error.events;
      }
    }

    let after = before;
    try {
      after = await runWithCleanupGrace("post-generation resource inventory", () =>
        captureInventory(resources.services),
      );
    } catch (error) {
      const detail = `generation resource inventory: ${error instanceof Error ? error.message : String(error)}`;
      this.recordCleanupIssue(run.id, detail);
      primaryError ??= new AgentProcessError(detail);
    }

    try {
      const audit = auditGeneratedResources({
        approvedPrimitives: input.plan.primitives,
        before,
        after,
        events: generationEvents,
      });
      const supervisor = new ResourceSupervisor();
      trackGeneratedResources({
        before,
        after,
        events: generationEvents,
        services: resources.services,
        supervisor,
      });
      for (const issue of await runWithCleanupGrace(
        "generated resource cleanup",
        () => supervisor.cleanup(),
      )) {
        this.recordCleanupIssue(run.id, issue.detail);
      }
      if (audit.violations.length > 0 && !primaryError) {
        primaryError = new AgentProcessError(audit.violations.join("; "));
      }
    } catch (error) {
      const detail = `generation resource cleanup: ${error instanceof Error ? error.message : String(error)}`;
      this.recordCleanupIssue(run.id, detail);
      primaryError ??= new AgentProcessError(detail);
    }

    if (primaryError) throw primaryError;
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
