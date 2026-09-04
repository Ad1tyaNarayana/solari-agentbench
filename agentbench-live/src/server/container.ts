import "server-only";

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CodexGenerator } from "@/core/agents/codex-generator";
import { CodexPlanner } from "@/core/agents/codex-planner";
import { runPreflight } from "@/core/agents/preflight";
import { SpawnCommandRunner } from "@/core/agents/process";
import {
  BenchmarkCatalog,
  BenchmarkSelectionError,
} from "@/core/benchmarks/catalog";
import {
  resolveBenchmarkRoots,
  resolveSnapshotRoot,
} from "@/core/benchmarks/config";
import { BenchmarkLoader } from "@/core/benchmarks/loader";
import { RunEventBus } from "@/core/events/run-events";
import { SqliteRunRepository } from "@/core/persistence/sqlite-repository";
import type { RunRepository } from "@/core/persistence/repository";
import {
  defaultSubmissionPolicy,
  packageSubmission,
} from "@/core/security/package-submission";
import { createWorkspace } from "@/core/security/workspace";
import { AgentBenchOrchestrator } from "@/core/runner/orchestrator";
import { RunQueue } from "@/core/runner/queue";
import { createSolariServices } from "@/core/solari/clients";
import { VerifierRegistry } from "@/core/verifiers/registry";
import {
  RunApiError,
  type RunApiPort,
} from "./contracts";
import {
  getOrCreateGlobalServerContainer,
  persistDetachedQueueFailure,
  reconcileAbandonedRuns,
} from "./recovery";

function selectionError(error: unknown): never {
  if (error instanceof BenchmarkSelectionError) {
    throw new RunApiError(error.code, error.message);
  }
  throw error;
}

type SubmissionOrchestrator = Pick<
  AgentBenchOrchestrator,
  "create" | "dryRun" | "runCreated"
>;

export function createRunSubmitter(input: {
  executionOrchestrator(): SubmissionOrchestrator;
  queue: RunQueue;
  repository: RunRepository;
  events: RunEventBus;
}): RunApiPort["submit"] {
  return async function submit(request) {
    try {
      if (request.dryRun) {
        return {
          kind: "dry-run",
          report: await input.executionOrchestrator().dryRun(request),
        };
      }

      const activeOrchestrator = input.executionOrchestrator();
      const created = await activeOrchestrator.create(request);
      void input.queue
        .enqueue(() =>
          activeOrchestrator.runCreated(created.run.id, created.selection),
        )
        .catch((error) => {
          persistDetachedQueueFailure({
            repository: input.repository,
            events: input.events,
            runId: created.run.id,
            error,
          });
        });
      return { kind: "run", run: created.run };
    } catch (error) {
      return selectionError(error);
    }
  };
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
  const catalog = new BenchmarkCatalog(
    resolveBenchmarkRoots(process.env.AGENTBENCH_BENCHMARK_ROOTS),
    new BenchmarkLoader(
      resolveSnapshotRoot(process.env.AGENTBENCH_SNAPSHOT_PATH),
    ),
  );
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
      resolveSelection: (request) => catalog.resolveSelection(request),
      preflight: async (selection) => {
        const result = await runPreflight(selection.agent, {
          runner,
          env: process.env,
        });
        if (!result.ok) {
          throw new RunApiError("preflight_failed", result.detailCode);
        }
      },
      createWorkspace,
      packageSubmission: (workspace) =>
        packageSubmission(workspace, defaultSubmissionPolicy),
      schemaPath: resolve("schemas/run-plan.schema.json"),
      solariApiKey,
      generationResources: { services },
    });
    return orchestrator;
  }

  const submit = createRunSubmitter({
    executionOrchestrator,
    queue,
    repository,
    events,
  });

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
