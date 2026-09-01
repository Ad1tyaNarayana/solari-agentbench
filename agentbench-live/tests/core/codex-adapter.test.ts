import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import type { RunPlan } from "@/core/domain/plan";
import type { AgentConfig } from "@/core/domain/run";
import type { TaskManifest } from "@/core/domain/task";
import {
  CodexGenerator,
  buildGeneratorCommand,
} from "@/core/agents/codex-generator";
import { parseJsonl } from "@/core/agents/jsonl";
import { CodexPlanner, PlanInvalidError } from "@/core/agents/codex-planner";
import type {
  CommandResult,
  CommandRunner,
  CommandSpec,
} from "@/core/agents/process";
import { SpawnCommandRunner } from "@/core/agents/process";
import { runPreflight } from "@/core/agents/preflight";

class FakeCommandRunner implements CommandRunner {
  readonly calls: CommandSpec[] = [];

  constructor(private readonly results: CommandResult[]) {}

  async run(spec: CommandSpec): Promise<CommandResult> {
    this.calls.push(spec);
    const result = this.results.shift();
    if (!result) throw new Error("No fake result configured");
    return result;
  }
}

const agent: AgentConfig = {
  id: "sol-low",
  label: "Sol · Low",
  model: "gpt-5.6-sol",
  reasoningEffort: "low",
};

const task: TaskManifest = {
  id: "sample",
  version: "1.0.0",
  title: "Sample",
  prompt: "Build the sample.",
  allowedPrimitives: ["sandbox", "browser"],
  requiredEvidence: ["sandbox"],
  budget: {
    totalMs: 60_000,
    browserMs: 0,
    sandboxMs: 60_000,
    desktopMs: 0,
  },
  verifier: "sample",
};

const validPlan: RunPlan = {
  primitives: ["sandbox"],
  reason: { sandbox: "build and test" },
  verificationStrategy: "run tests",
};

const plannerInput = {
  agent,
  task,
  schemaPath: "C:\\schemas\\run-plan.schema.json",
  outputPath: "C:\\temp\\plan.json",
  plannerPrompt: "Choose the required primitives.",
  timeoutMs: 5_000,
};

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    events: [],
    ...overrides,
  };
}

test("planner registers no MCP server and retries invalid JSON once", async () => {
  const runner = new FakeCommandRunner([
    result({ outputFile: "{bad json" }),
    result({ outputFile: JSON.stringify(validPlan) }),
  ]);
  const planner = new CodexPlanner(runner);
  await expect(planner.plan(plannerInput)).resolves.toEqual(validPlan);
  expect(runner.calls).toHaveLength(2);
  expect(runner.calls[0].args.join(" ")).not.toContain("mcp_servers");
  expect(runner.calls[0].args).toContain("--output-schema");
  expect(runner.calls[1].args.at(-1)).toMatch(/previous plan was invalid/i);
});

test("planner fails closed after its single retry", async () => {
  const runner = new FakeCommandRunner([
    result({ outputFile: "{}" }),
    result({ outputFile: "{}" }),
  ]);
  await expect(new CodexPlanner(runner).plan(plannerInput)).rejects.toBeInstanceOf(
    PlanInvalidError,
  );
  expect(runner.calls).toHaveLength(2);
});

test("generator attaches only the Solari MCP server", () => {
  const spec = buildGeneratorCommand({
    agent,
    plan: validPlan,
    taskPrompt: task.prompt,
    workspace: { root: "C:\\temp\\workspace" },
    solariApiKey: "test-solari-key",
    timeoutMs: 5_000,
  });
  expect(spec.args).toContain("--ignore-user-config");
  expect(spec.args.join(" ")).toContain("mcp_servers.solari.command");
  expect(spec.args.join(" ")).toContain("@solarisdk/mcp");
  expect(spec.args.join(" ")).not.toContain("test-solari-key");
  expect(spec.env?.SOLARI_API_KEY).toBe("test-solari-key");
});

test("generator returns structured events from the process boundary", async () => {
  const runner = new FakeCommandRunner([
    result({ events: [{ type: "turn.completed", usage: { output_tokens: 8 } }] }),
  ]);
  const generation = await new CodexGenerator(runner).generate({
    agent,
    plan: validPlan,
    taskPrompt: task.prompt,
    workspace: { root: "C:\\temp\\workspace" },
    solariApiKey: "test-solari-key",
    timeoutMs: 5_000,
  });
  expect(generation.events).toEqual([
    { type: "turn.completed", usage: { output_tokens: 8 } },
  ]);
});

test("JSONL parsing redacts secrets before returning events", () => {
  const fixture = readFileSync(
    resolve("tests/fixtures/codex/generator.jsonl"),
    "utf8",
  );
  const events = parseJsonl(
    `${fixture}{"type":"log","value":"Bearer slr_live_id_secret"}\n`,
  );
  expect(events).toHaveLength(3);
  expect(JSON.stringify(events)).not.toContain("slr_live_id_secret");
});

test("spawn runner reports a timed out process", async () => {
  const runner = new SpawnCommandRunner();
  const command = await runner.run({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    timeoutMs: 50,
  });
  expect(command.timedOut).toBe(true);
});

test("preflight fails without exposing or invoking a missing Solari key", async () => {
  const runner = new FakeCommandRunner([]);
  await expect(runPreflight(agent, { runner, env: {} })).resolves.toEqual({
    ok: false,
    failureCode: "agent_failed",
    detailCode: "solari_key_missing",
  });
  expect(runner.calls).toHaveLength(0);
});

test("preflight maps a rejected configured model", async () => {
  const runner = new FakeCommandRunner([
    result(),
    result({ exitCode: 1, stderr: "model is not available" }),
  ]);
  await expect(
    runPreflight(agent, {
      runner,
      env: { SOLARI_API_KEY: "test-solari-key" },
    }),
  ).resolves.toEqual({
    ok: false,
    failureCode: "agent_failed",
    detailCode: "model_unavailable",
  });
});
