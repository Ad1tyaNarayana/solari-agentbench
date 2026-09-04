import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { RunPlan } from "@/core/domain/plan";
import type { AgentConfig } from "@/core/domain/run";
import type { TaskManifest } from "@/core/domain/task";
import {
  CodexGenerator,
  buildGeneratorCommand,
  solariToolsForPrimitives,
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
  expect(spec.args).toContain("--approve-for-me");
  expect(spec.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(spec.args).not.toContain("--sandbox");
  expect(spec.args.join(" ")).toContain("mcp_servers.solari.command");
  expect(spec.args).toContain(
    `mcp_servers.solari.command=${JSON.stringify(process.execPath)}`,
  );
  expect(spec.args.join(" ")).toContain("solari-mcp-guard.mjs");
  expect(spec.args.join(" ")).toContain("@solarisdk/mcp@0.4.3");
  expect(spec.args).toContain(
    'mcp_servers.solari.enabled_tools=["solari_sandbox_create","solari_list","solari_kill","solari_connect","solari_exec","solari_run_command_bg","solari_run_code","solari_read_file","solari_write_file","solari_list_files","solari_get_preview_url"]',
  );
  expect(spec.args.join(" ")).not.toContain("test-solari-key");
  expect(spec.args.at(-1)).toMatch(/create the mandatory submission files first/i);
  expect(spec.args.at(-1)).toMatch(/results\.json/i);
  expect(spec.args.at(-1)).toMatch(/do not verify or polish until/i);
  expect(spec.env?.SOLARI_API_KEY).toBe("test-solari-key");
});

test("uses exact MCP v0.4.3 tool allowlists for each approved primitive", () => {
  expect(solariToolsForPrimitives(["browser"])).toEqual([
    "solari_browser_create",
    "solari_browser_profiles",
    "solari_browser_autologin_status",
    "solari_browser_autologin_site",
    "solari_browser_login",
    "solari_browser_save_profile",
    "solari_browser_await_login",
    "solari_browser_navigate",
    "solari_browser_read_page",
    "solari_browser_screenshot",
    "solari_browser_click",
    "solari_browser_type",
    "solari_browser_key",
    "solari_browser_evaluate",
    "solari_browser_replay_url",
    "solari_browser_close",
  ]);
  expect(solariToolsForPrimitives(["sandbox"])).toEqual([
    "solari_sandbox_create",
    "solari_list",
    "solari_kill",
    "solari_connect",
    "solari_exec",
    "solari_run_command_bg",
    "solari_run_code",
    "solari_read_file",
    "solari_write_file",
    "solari_list_files",
    "solari_get_preview_url",
  ]);
  expect(solariToolsForPrimitives(["desktop"])).toEqual([
    "solari_desktop_create",
    "solari_list",
    "solari_kill",
    "solari_connect",
    "solari_exec",
    "solari_run_command_bg",
    "solari_run_code",
    "solari_read_file",
    "solari_write_file",
    "solari_list_files",
    "solari_get_preview_url",
    "solari_screenshot",
    "solari_click",
    "solari_type",
    "solari_key",
    "solari_open_app",
  ]);
});

afterEach(() => vi.unstubAllEnvs());

test("planner and generator child environments exclude unrelated secrets", async () => {
  vi.stubEnv("UNRELATED_DEPLOY_SECRET", "must-not-cross-process-boundary");
  vi.stubEnv("SOLARI_API_KEY", "ambient-solari-key");
  const runner = new FakeCommandRunner([
    result({ outputFile: JSON.stringify(validPlan) }),
  ]);
  await new CodexPlanner(runner).plan(plannerInput);
  expect(runner.calls[0].env?.UNRELATED_DEPLOY_SECRET).toBeUndefined();
  expect(runner.calls[0].env?.SOLARI_API_KEY).toBeUndefined();

  const generation = buildGeneratorCommand({
    agent,
    plan: validPlan,
    taskPrompt: task.prompt,
    workspace: { root: "C:\\temp\\workspace" },
    solariApiKey: "explicit-solari-key",
    timeoutMs: 5_000,
  });
  expect(generation.env?.UNRELATED_DEPLOY_SECRET).toBeUndefined();
  expect(generation.env?.SOLARI_API_KEY).toBe("explicit-solari-key");
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
  expect(events).toContainEqual({
    type: "turn.completed",
    usage: { input_tokens: 20, output_tokens: 8 },
  });
  expect(JSON.stringify(events)).not.toContain("slr_live_id_secret");
});

test("JSONL redaction preserves object delimiters around signed URLs", () => {
  const [event] = parseJsonl(
    '{"type":"log","url":"https://stream.getsolari.com/signed?token=secret","after":true}',
  );
  expect(event).toEqual({
    type: "log",
    url: "[REDACTED_SOLARI_URL]",
    after: true,
  });
});

test("JSONL redaction keeps structured events parseable across escaped keys and values", () => {
  const [event] = parseJsonl(
    '{"type":"log","t\\u006fken":{"nested":"secret"},"details":{"api\\u005fkey":["secret"],"token_details":{"cached":2},"note":"token=abc\\\"def","url":"https://example.test/oauth/token?mode=view"}}',
  );

  expect(event).toEqual({
    type: "log",
    token: "[REDACTED]",
    details: {
      api_key: "[REDACTED]",
      token_details: { cached: 2 },
      note: "token=[REDACTED]",
      url: "https://example.test/oauth/token?mode=view",
    },
  });
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

test.skipIf(process.platform === "win32")(
  "Unix timeout escalates from SIGTERM to SIGKILL for a resistant child",
  async () => {
    const runner = new SpawnCommandRunner();
    const startedAt = Date.now();
    const command = await runner.run({
      command: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ],
      timeoutMs: 50,
      terminationGraceMs: 50,
    });
    expect(command.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  },
);

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
