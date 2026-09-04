import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import type { AgentConfig } from "@/core/domain/run";
import { parseJsonl } from "@/core/agents/jsonl";
import type { CommandResult, CommandRunner, CommandSpec } from "@/core/agents/process";
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

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return { exitCode: 0, stdout: "", stderr: "", timedOut: false, events: [], ...overrides };
}

test("JSONL parsing redacts secrets before returning events", () => {
  const fixture = readFileSync(resolve("tests/fixtures/codex/generator.jsonl"), "utf8");
  const events = parseJsonl(`${fixture}{"type":"log","value":"Bearer slr_live_id_secret"}\n`);
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
  expect(event).toEqual({ type: "log", url: "[REDACTED_SOLARI_URL]", after: true });
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
  const command = await new SpawnCommandRunner().run({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    timeoutMs: 50,
  });
  expect(command.timedOut).toBe(true);
});

test.skipIf(process.platform === "win32")(
  "Unix timeout escalates from SIGTERM to SIGKILL for a resistant child",
  async () => {
    const startedAt = Date.now();
    const command = await new SpawnCommandRunner().run({
      command: process.execPath,
      args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
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
  await expect(runPreflight(agent, {
    runner,
    env: { SOLARI_API_KEY: "test-solari-key" },
  })).resolves.toEqual({
    ok: false,
    failureCode: "agent_failed",
    detailCode: "model_unavailable",
  });
});
