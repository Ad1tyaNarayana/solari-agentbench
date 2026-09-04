import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BenchmarkCatalog,
  BenchmarkSelectionError,
  DEFAULT_BENCHMARK_ID,
} from "@/core/benchmarks/catalog";
import {
  resolveBenchmarkRoots,
  resolveSnapshotRoot,
} from "@/core/benchmarks/config";
import { BenchmarkLoader } from "@/core/benchmarks/loader";
import type { AgentConfig } from "@/core/domain/run";
import type { RunRecord } from "@/core/domain/run";
import type { TaskManifest } from "@/core/domain/task";
import { exportPublicDemo } from "@/core/demo/seed";
import { RunEventBus } from "@/core/events/run-events";
import { SqliteRunRepository } from "@/core/persistence/sqlite-repository";
import {
  createBuiltinProviderRegistry,
  createDefaultCredentialStore,
} from "@/core/providers/builtins";
import { defaultSubmissionPolicy, packageSubmission } from "@/core/security/package-submission";
import { createWorkspace } from "@/core/security/workspace";
import { estimateResources } from "@/core/runner/budget";
import type { DryRunReport, RunRequest } from "@/core/runner/contracts";
import { runMatrix as executeMatrix } from "@/core/runner/matrix";
import { AgentBenchOrchestrator } from "@/core/runner/orchestrator";
import { createSolariServices } from "@/core/solari/clients";
import { runSolariSmokePreflight, type SmokePreflightFailure, type SmokeReport } from "@/core/solari/smoke";
import { VerifierRegistry } from "@/core/verifiers/registry";
import { createAgentToolBroker } from "@/core/tools/broker";
import { EvaluationEngine } from "@/core/evaluators/engine";
import { createBuiltinEvaluatorRegistry } from "@/core/evaluators/builtins";

type CliMatrixOptions = { benchmarkId: string; concurrency: number };

export interface CliRuntime {
  dryRun(request: RunRequest): Promise<DryRunReport>;
  runOne(request: RunRequest): Promise<RunRecord>;
  matrixSummary(options: CliMatrixOptions): Promise<string>;
  runMatrix(options: CliMatrixOptions): Promise<RunRecord[]>;
  smoke(): Promise<SmokeReport | SmokePreflightFailure | unknown>;
  writeLine(line: string): void;
  dispose(): Promise<void>;
}

type ParsedArguments = {
  command: string;
  values: Map<string, string | boolean>;
};

function parseArguments(argv: string[]): ParsedArguments {
  const [command = "help", ...rest] = argv;
  const values = new Map<string, string | boolean>();
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) continue;
    const equals = item.indexOf("=");
    if (equals >= 0) {
      values.set(item.slice(2, equals), item.slice(equals + 1));
      continue;
    }
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(item.slice(2), next);
      index += 1;
    } else {
      values.set(item.slice(2), true);
    }
  }
  return { command, values };
}

function required(values: Map<string, string | boolean>, key: string): string {
  const value = values.get(key);
  if (typeof value !== "string" || !value) throw new Error(`--${key} is required`);
  return value;
}

function confirmed(values: Map<string, string | boolean>): boolean {
  const value = values.get("yes");
  return value === true || value === "true";
}

function selectedBenchmark(values: Map<string, string | boolean>): string {
  const value = values.get("benchmark");
  if (value === undefined) return DEFAULT_BENCHMARK_ID;
  if (typeof value !== "string" || !value) {
    throw new Error("--benchmark requires a value");
  }
  return value;
}

function formatMatrixSummary(
  concurrency: number,
  agents: AgentConfig[],
  tasks: TaskManifest[],
): string {
  const estimates = estimateResources(
    agents.flatMap(() => tasks.map((task) => ({ budget: task.budget }))),
  );
  const minutes = (milliseconds: number) => (milliseconds / 60_000).toFixed(1);
  return [
    `${agents.length} agents × ${tasks.length} tasks = ${estimates.jobs} runs`,
    `concurrency ${concurrency}`,
    `browser ${minutes(estimates.browserMs)} min`,
    `sandbox ${minutes(estimates.sandboxMs)} min`,
    `desktop ${minutes(estimates.desktopMs)} min`,
    `total ${minutes(estimates.totalMs)} min maximum`,
  ].join(" · ");
}

export async function runCli(
  argv: string[],
  runtime?: CliRuntime,
): Promise<void> {
  const parsed = parseArguments(argv);
  if (parsed.command === "demo:seed") {
    try {
      const output = parsed.values.get("output");
      await exportPublicDemo(typeof output === "string" ? resolve(output) : undefined);
      (runtime?.writeLine ?? console.log)("Public demo artifacts exported.");
      return;
    } finally {
      await runtime?.dispose();
    }
  }

  const activeRuntime = runtime ?? createDefaultRuntime();
  try {
    if (parsed.command === "dry-run") {
      const report = await activeRuntime.dryRun({
        benchmarkId: selectedBenchmark(parsed.values),
        taskId: required(parsed.values, "task"),
        agentId: required(parsed.values, "agent"),
      });
      activeRuntime.writeLine(JSON.stringify(report, null, 2));
      return;
    }
    if (parsed.command === "smoke") {
      activeRuntime.writeLine(JSON.stringify(await activeRuntime.smoke(), null, 2));
      return;
    }
    if (parsed.command === "run") {
      const run = await activeRuntime.runOne({
        benchmarkId: selectedBenchmark(parsed.values),
        taskId: required(parsed.values, "task"),
        agentId: required(parsed.values, "agent"),
      });
      activeRuntime.writeLine(JSON.stringify(run, null, 2));
      return;
    }
    if (parsed.command === "matrix") {
      const concurrencyValue = parsed.values.get("concurrency") ?? "1";
      const concurrency = Number(concurrencyValue);
      const options = {
        benchmarkId: selectedBenchmark(parsed.values),
        concurrency,
      };
      activeRuntime.writeLine(await activeRuntime.matrixSummary(options));
      if (!confirmed(parsed.values)) throw new Error("Matrix confirmation required; pass --yes");
      const records = await activeRuntime.runMatrix(options);
      activeRuntime.writeLine(JSON.stringify(records, null, 2));
      return;
    }
    throw new Error("Usage: agentbench <dry-run|smoke|run|matrix|demo:seed> [options]");
  } finally {
    await activeRuntime.dispose();
  }
}

export function createDefaultRuntime(): CliRuntime {
  const databasePath = process.env.AGENTBENCH_DATABASE_PATH ?? ".agentbench/agentbench.sqlite";
  mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  const repository = new SqliteRunRepository(databasePath);
  const events = new RunEventBus();
  const solariApiKey = process.env.SOLARI_API_KEY ?? "";
  const services = createSolariServices(solariApiKey);
  const credentials = createDefaultCredentialStore();
  const providers = createBuiltinProviderRegistry(credentials);
  const catalog = new BenchmarkCatalog(
    resolveBenchmarkRoots(process.env.AGENTBENCH_BENCHMARK_ROOTS),
    new BenchmarkLoader(
      resolveSnapshotRoot(process.env.AGENTBENCH_SNAPSHOT_PATH),
    ),
  );
  const orchestrator = new AgentBenchOrchestrator({
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

  return {
    dryRun: (request) => orchestrator.dryRun(request),
    runOne: (request) => orchestrator.run(request),
    async matrixSummary(options) {
      const [agents, tasks] = await Promise.all([
        catalog.listAgents(options.benchmarkId),
        catalog.listTasks(options.benchmarkId),
      ]);
      return formatMatrixSummary(options.concurrency, agents, tasks);
    },
    async runMatrix(options) {
      const [agents, tasks] = await Promise.all([
        catalog.listAgents(options.benchmarkId),
        catalog.listTasks(options.benchmarkId),
      ]);
      return executeMatrix(orchestrator, {
        benchmarkId: options.benchmarkId,
        confirm: true,
        concurrency: options.concurrency,
        agents,
        tasks,
      });
    },
    smoke: () => runSolariSmokePreflight(solariApiKey, services),
    writeLine: (line) => console.log(line),
    async dispose() {
      try {
        await services.dispose?.();
      } finally {
        repository.close();
      }
    },
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      error instanceof BenchmarkSelectionError
        ? error.code
        : error instanceof Error
          ? error.message
          : String(error),
    );
    process.exitCode = 1;
  });
}
