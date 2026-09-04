import "server-only";

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
  createBuiltinProviderRegistry,
  createDefaultCredentialStore,
} from "@/core/providers/builtins";
import {
  defaultSubmissionPolicy,
  packageSubmission,
} from "@/core/security/package-submission";
import { createWorkspace } from "@/core/security/workspace";
import { createAgentToolBroker } from "@/core/tools/broker";
import { AgentBenchOrchestrator } from "@/core/runner/orchestrator";
import { RunQueue } from "@/core/runner/queue";
import { createSolariServices } from "@/core/solari/clients";
import { VerifierRegistry } from "@/core/verifiers/registry";
import { EvaluationEngine } from "@/core/evaluators/engine";
import { createBuiltinEvaluatorRegistry } from "@/core/evaluators/builtins";
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
    const credentials = createDefaultCredentialStore();
    const providers = createBuiltinProviderRegistry(credentials);
    orchestrator = new AgentBenchOrchestrator({
      repository,
      events,
      providers,
      credentials,
      createToolBroker: (input) => createAgentToolBroker({ ...input, services }),
      verifier: new VerifierRegistry(services),
      evaluator: new EvaluationEngine({
        registry: createBuiltinEvaluatorRegistry(services),
        services,
        providers,
        credentials,
        evidenceRoot: resolve(".agentbench/evidence"),
      }),
      resolveSelection: (request) => catalog.resolveSelection(request),
      preflight: async () => undefined,
      createWorkspace,
      packageSubmission: (workspace) =>
        packageSubmission(workspace, defaultSubmissionPolicy),
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
