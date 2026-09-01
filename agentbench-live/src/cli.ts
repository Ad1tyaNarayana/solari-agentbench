import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CodexGenerator } from "@/core/agents/codex-generator";
import { CodexPlanner } from "@/core/agents/codex-planner";
import { runPreflight } from "@/core/agents/preflight";
import { SpawnCommandRunner } from "@/core/agents/process";
import type { RunRecord } from "@/core/domain/run";
import { RunEventBus } from "@/core/events/run-events";
import { SqliteRunRepository } from "@/core/persistence/sqlite-repository";
import { defaultSubmissionPolicy, packageSubmission } from "@/core/security/package-submission";
import { createWorkspace } from "@/core/security/workspace";
import { estimateResources } from "@/core/runner/budget";
import type { DryRunReport, RunRequest } from "@/core/runner/contracts";
import { runMatrix as executeMatrix } from "@/core/runner/matrix";
import { AgentBenchOrchestrator } from "@/core/runner/orchestrator";
import { createSolariServices } from "@/core/solari/clients";
import { runSolariSmoke, type SmokeReport } from "@/core/solari/smoke";
import { agents, getAgent, getTask, listTasks } from "@/core/tasks/registry";
import { VerifierRegistry } from "@/core/verifiers/registry";

export interface CliRuntime {
  dryRun(request: RunRequest): Promise<DryRunReport>;
  runOne(request: RunRequest): Promise<RunRecord>;
  runMatrix(options: { concurrency: number }): Promise<RunRecord[]>;
  smoke(): Promise<SmokeReport | unknown>;
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

function matrixSummary(concurrency: number): string {
  const tasks = listTasks();
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
  runtime: CliRuntime = createDefaultRuntime(),
): Promise<void> {
  const parsed = parseArguments(argv);
  try {
    if (parsed.command === "dry-run") {
      const report = await runtime.dryRun({
        taskId: required(parsed.values, "task"),
        agentId: required(parsed.values, "agent"),
      });
      runtime.writeLine(JSON.stringify(report, null, 2));
      return;
    }
    if (parsed.command === "smoke") {
      runtime.writeLine(JSON.stringify(await runtime.smoke(), null, 2));
      return;
    }
    if (parsed.command === "run") {
      const run = await runtime.runOne({
        taskId: required(parsed.values, "task"),
        agentId: required(parsed.values, "agent"),
      });
      runtime.writeLine(JSON.stringify(run, null, 2));
      return;
    }
    if (parsed.command === "matrix") {
      const concurrencyValue = parsed.values.get("concurrency") ?? "1";
      const concurrency = Number(concurrencyValue);
      runtime.writeLine(matrixSummary(concurrency));
      if (!confirmed(parsed.values)) throw new Error("Matrix confirmation required; pass --yes");
      const records = await runtime.runMatrix({ concurrency });
      runtime.writeLine(JSON.stringify(records, null, 2));
      return;
    }
    throw new Error("Usage: agentbench <dry-run|smoke|run|matrix> [options]");
  } finally {
    await runtime.dispose();
  }
}

export function createDefaultRuntime(): CliRuntime {
  const databasePath = process.env.AGENTBENCH_DATABASE_PATH ?? ".agentbench/agentbench.sqlite";
  mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  const repository = new SqliteRunRepository(databasePath);
  const events = new RunEventBus();
  const runner = new SpawnCommandRunner();
  const services = createSolariServices(process.env.SOLARI_API_KEY ?? "");
  const orchestrator = new AgentBenchOrchestrator({
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
    solariApiKey: process.env.SOLARI_API_KEY ?? "",
    generationResources: { services },
  });

  const requirePreflight = async (agentId: string) => {
    const preflight = await runPreflight(getAgent(agentId), {
      runner,
      env: process.env,
    });
    if (!preflight.ok) throw new Error(`Preflight failed: ${preflight.detailCode}`);
  };

  return {
    dryRun: (request) => orchestrator.dryRun(request),
    async runOne(request) {
      await requirePreflight(request.agentId);
      return orchestrator.run(request);
    },
    async runMatrix(options) {
      for (const agent of agents) await requirePreflight(agent.id);
      return executeMatrix(orchestrator, {
        confirm: true,
        concurrency: options.concurrency,
        agents: [...agents],
        tasks: listTasks(),
      });
    },
    smoke: () => runSolariSmoke(services),
    writeLine: (line) => console.log(line),
    async dispose() {
      repository.close();
    },
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
