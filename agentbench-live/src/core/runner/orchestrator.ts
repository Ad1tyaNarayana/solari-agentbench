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
import { transition } from "./state-machine";
import type {
  DryRunReport,
  OrchestratorDependencies,
  RunRequest,
} from "./contracts";

export class AgentBenchOrchestrator {
  constructor(private readonly dependencies: OrchestratorDependencies) {}

  async dryRun(request: RunRequest): Promise<DryRunReport> {
    const task = this.dependencies.getTask(request.taskId);
    const agent = this.dependencies.getAgent(request.agentId);
    const plan = await this.plan(`dry-${Date.now()}`, task, agent);
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
    const task = this.dependencies.getTask(request.taskId);
    const agent = this.dependencies.getAgent(request.agentId);
    const created = this.dependencies.repository.create({
      taskId: task.id,
      taskVersion: task.version,
      agentId: agent.id,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
    });
    const startedAt = new Date().toISOString();
    let run = this.dependencies.repository.update(created.id, { startedAt });
    let workspace: DisposableWorkspace | undefined;

    try {
      run = this.move(run, "planning");
      const plan = await this.plan(run.id, task, agent);
      run = this.dependencies.repository.update(run.id, { runPlan: plan });

      workspace = await this.dependencies.createWorkspace(run.id);
      run = this.move(run, "generating");
      await this.dependencies.generator.generate({
        agent,
        plan,
        taskPrompt: task.prompt,
        workspace,
        solariApiKey: this.dependencies.solariApiKey,
        timeoutMs: task.budget.totalMs,
      });
      const submission = await this.dependencies.packageSubmission(workspace);

      run = this.move(run, "provisioning");
      run = this.move(run, "building");
      run = this.move(run, "verifying");
      const verification = await this.dependencies.verifier.verify({
        run,
        task,
        agent,
        plan,
        submission,
      });
      run = this.move(run, "capturing");
      run = this.dependencies.repository.update(run.id, {
        score: { ...verification.score },
        evidence: verification.evidence,
        sanitizedLogs: verification.logs.map((line) =>
          redact(line, { localRoots: workspace ? [workspace.root] : [] }),
        ),
      });
      run = this.move(run, "completed", {
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - Date.parse(startedAt),
      });
    } catch (error) {
      run = this.fail(run, error, workspace);
    } finally {
      if (workspace) {
        try {
          await workspace.dispose();
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

    return this.requireRun(run.id);
  }

  private async plan(
    runId: string,
    task: TaskManifest,
    agent: AgentConfig,
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
        timeoutMs: Math.min(task.budget.totalMs, 120_000),
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
  ): RunRecord {
    const detail = redact(error instanceof Error ? error.message : String(error), {
      localRoots: workspace ? [workspace.root] : [],
    });
    const failureCode = this.failureCode(error, run.stage);
    const updated = this.dependencies.repository.update(run.id, {
      stage: transition(run.stage, "failed"),
      failureCode,
      failureDetail: detail,
      completedAt: new Date().toISOString(),
    });
    const event = this.dependencies.repository.appendEvent(run.id, {
      kind: "stage",
      payload: { stage: "failed", failureCode },
    });
    this.dependencies.events.publish(run.id, event);
    return updated;
  }

  private failureCode(error: unknown, stage: RunStage): FailureCode {
    if (error instanceof PlanInvalidError) return "plan_invalid";
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
}
