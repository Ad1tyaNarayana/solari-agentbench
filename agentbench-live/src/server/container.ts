import "server-only";

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CodexGenerator } from "@/core/agents/codex-generator";
import { CodexPlanner } from "@/core/agents/codex-planner";
import { runPreflight } from "@/core/agents/preflight";
import { SpawnCommandRunner } from "@/core/agents/process";
import { RunEventBus } from "@/core/events/run-events";
import { SqliteRunRepository } from "@/core/persistence/sqlite-repository";
import {
  defaultSubmissionPolicy,
  packageSubmission,
} from "@/core/security/package-submission";
import { createWorkspace } from "@/core/security/workspace";
import type { RunRequest } from "@/core/runner/contracts";
import { AgentBenchOrchestrator } from "@/core/runner/orchestrator";
import { RunQueue } from "@/core/runner/queue";
import { createSolariServices } from "@/core/solari/clients";
import { getAgent, getTask } from "@/core/tasks/registry";
import { VerifierRegistry } from "@/core/verifiers/registry";
import {
  RunApiError,
  type RunApiPort,
  type RunSubmission,
} from "./contracts";
import {
  getOrCreateGlobalServerContainer,
  persistDetachedQueueFailure,
  reconcileAbandonedRuns,
} from "./recovery";

function selectionError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Unknown task:")) {
    throw new RunApiError("unknown_task", message);
  }
  if (message.startsWith("Unknown agent:")) {
    throw new RunApiError("unknown_agent", message);
  }
  throw error;
}

export function createServerContainer(): RunApiPort {
  const configuredDatabasePath =
    process.env.AGENTBENCH_DATABASE_PATH ?? ".agentbench/agentbench.sqlite";
  const databasePath = resolve(
    /* turbopackIgnore: true */ configuredDatabasePath,
  );
  mkdirSync(dirname(databasePath), { recursive: true });
  const repository = new SqliteRunRepository(databasePath);
  reconcileAbandonedRuns(repository);
  const events = new RunEventBus();
  const runner = new SpawnCommandRunner();
  const queue = new RunQueue(1);
  let orchestrator: AgentBenchOrchestrator | undefined;

  function executionOrchestrator(): AgentBenchOrchestrator {
    if (orchestrator) return orchestrator;
    const solariApiKey = process.env.SOLARI_API_KEY ?? "";
    const services = createSolariServices(solariApiKey);
    orchestrator = new AgentBenchOrchestrator({
      repository,
      events,
      planner: new CodexPlanner(runner),
      generator: new CodexGenerator(runner),
      verifier: new VerifierRegistry(services),
      getTask,
      getAgent,
      createWorkspace,
      packageSubmission: (workspace) =>
        packageSubmission(workspace, defaultSubmissionPolicy),
      schemaPath: resolve("schemas/run-plan.schema.json"),
      solariApiKey,
      generationResources: { services },
    });
    return orchestrator;
  }

  async function submit(
    request: RunRequest & { dryRun?: boolean },
  ): Promise<RunSubmission> {
    let agent;
    try {
      getTask(request.taskId);
      agent = getAgent(request.agentId);
    } catch (error) {
      return selectionError(error);
    }

    if (request.dryRun) {
      return {
        kind: "dry-run",
        report: await executionOrchestrator().dryRun(request),
      };
    }

    const preflight = await runPreflight(agent, { runner, env: process.env });
    if (!preflight.ok) {
      throw new RunApiError("preflight_failed", preflight.detailCode);
    }

    const activeOrchestrator = executionOrchestrator();
    const run = activeOrchestrator.create(request);
    void queue
      .enqueue(() => activeOrchestrator.runCreated(run.id, request))
      .catch((error) => {
        persistDetachedQueueFailure({
          repository,
          events,
          runId: run.id,
          error,
        });
      });
    return { kind: "run", run };
  }

  return {
    submit,
    listRuns: () => repository.list(),
    getRun: (id) => repository.get(id),
    listEvents: (runId) => repository.listEvents(runId),
    subscribe: (runId, listener) => events.subscribe(runId, listener),
  };
}

export function getServerContainer(): RunApiPort {
  return getOrCreateGlobalServerContainer(
    "agentbench-live-server-container-v1",
    createServerContainer,
  );
}
