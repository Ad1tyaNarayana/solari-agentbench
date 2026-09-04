import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentDefinition, BenchmarkTaskDefinition } from "@/core/benchmarks/types";
import { createAgentEventSink, type AgentEvent } from "@/core/providers/events";
import { ExecutableJsonlProvider } from "@/core/providers/executable-jsonl";
import type { AgentEventSink, ProviderExecutionInput } from "@/core/providers/types";

const fixture = resolve("tests/fixtures/providers/fake-jsonl-agent.mjs");
const task: BenchmarkTaskDefinition = {
  id: "sample",
  name: "Sample",
  promptPath: "tasks/sample/prompt.md",
  prompt: "Build the sample.",
  fixtures: [],
  allowedPrimitives: ["sandbox"],
  planningRequired: true,
  resourceLimits: { browserSessions: 0, sandboxes: 1, desktops: 0, totalMinutes: 5 },
  submission: { directory: "submission", required: ["results.json"] },
  evaluationPolicy: { maxModelJudgeWeight: 30, allowModelJudgeMajority: false },
  evaluators: [],
};
const snapshot = { digest: "digest", root: process.cwd(), files: [] };

function agent(mode = "happy"): AgentDefinition {
  return {
    id: `jsonl-${mode}`,
    name: "JSONL fixture",
    provider: "executable-jsonl",
    model: "fake-model",
    harness: { id: "fixture", version: "1" },
    options: { command: [process.execPath, fixture, mode] },
  };
}

function recordingSink(): { sink: AgentEventSink; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return {
    events,
    sink: createAgentEventSink({
      provider: "executable-jsonl",
      redact: (value) => value,
      publish: (event) => events.push(event),
      now: () => "2026-09-04T00:00:00.000Z",
    }),
  };
}

function executionInput(mode = "happy"): ProviderExecutionInput {
  return {
    agent: agent(mode),
    task,
    snapshot,
    plan: {
      primitives: ["sandbox"],
      reason: { sandbox: "run isolated checks" },
      verificationStrategy: "inspect the generated result",
    },
    workspace: { root: process.cwd(), dispose: async () => undefined },
    tools: { listDefinitions: () => [], invoke: async () => ({ content: "fixture" }) },
    remainingMs: () => 10_000,
  };
}

describe("ExecutableJsonlProvider", () => {
  it("handshakes and validates a version 1 run plan", async () => {
    const provider = new ExecutableJsonlProvider();

    const plan = await provider.plan(
      { agent: agent(), task, snapshot, remainingMs: () => 10_000 },
      new AbortController().signal,
    );

    expect(plan).toEqual({
      primitives: ["sandbox"],
      reason: { sandbox: "run isolated checks" },
      verificationStrategy: "inspect the generated result",
    });
  });

  it("streams normalized events and round-trips broker tool results", async () => {
    const provider = new ExecutableJsonlProvider({ createHandleId: () => "run-1" });
    const input = executionInput();
    const invoke = vi.fn(input.tools.invoke);
    input.tools = { ...input.tools, invoke };
    const { sink, events } = recordingSink();

    const execution = await provider.execute(input, sink, new AbortController().signal);
    const result = await execution.result;

    expect(execution.handle).toEqual({ id: "run-1" });
    expect(invoke).toHaveBeenCalledWith(
      "workspace_read",
      { path: "prompt.md" },
      expect.any(AbortSignal),
    );
    expect(events.map((event) => event.kind)).toEqual([
      "message",
      "tool-request",
      "tool-result",
    ]);
    expect(result).toEqual({
      resolvedModel: "fake-model",
      finalResponse: "finished",
      usage: { inputTokens: 3, outputTokens: 2 },
      nativeTranscript: expect.stringContaining('"type":"result"'),
    });
  });

  it.each(["malformed", "oversized", "duplicate", "nonzero", "invalidresult"])(
    "rejects %s harness protocol failures with a typed agent error",
    async (mode) => {
      const provider = new ExecutableJsonlProvider();
      const { sink } = recordingSink();
      const execution = await provider.execute(
        executionInput(mode),
        sink,
        new AbortController().signal,
      );

      const failure = await execution.result.catch((error: unknown) => error);
      expect(failure).toEqual(
        expect.objectContaining({ code: "agent_failed" }),
      );
      expect(JSON.stringify(failure)).not.toContain("child-secret");
    },
  );

  it("sends cancellation and terminates an unresponsive harness", async () => {
    const provider = new ExecutableJsonlProvider({ createHandleId: () => "cancel-1" });
    const { sink } = recordingSink();
    const execution = await provider.execute(
      executionInput("hang"),
      sink,
      new AbortController().signal,
    );

    await provider.cancel(execution.handle);

    await expect(execution.result).rejects.toEqual(
      expect.objectContaining({ code: "agent_failed" }),
    );
  });

  it("propagates the run abort signal to an unresponsive harness", async () => {
    const provider = new ExecutableJsonlProvider();
    const { sink } = recordingSink();
    const controller = new AbortController();
    const execution = await provider.execute(executionInput("hang"), sink, controller.signal);

    controller.abort(new Error("run cancelled"));

    await expect(execution.result).rejects.toEqual(
      expect.objectContaining({ code: "agent_failed" }),
    );
  });

  it("enforces the remaining run deadline while waiting for output", async () => {
    const provider = new ExecutableJsonlProvider();
    const input = executionInput("hang");
    input.remainingMs = () => 20;
    const { sink } = recordingSink();
    const execution = await provider.execute(input, sink, new AbortController().signal);

    await expect(execution.result).rejects.toEqual(
      expect.objectContaining({ code: "agent_failed" }),
    );
  });

  it("preflight validates the provider and command without spawning it", async () => {
    const provider = new ExecutableJsonlProvider();
    await expect(provider.preflight({ agent: agent("does-not-exist"), task, snapshot }))
      .resolves.toEqual({ ok: true });
    await expect(
      provider.preflight({
        agent: { ...agent(), options: { command: [] } },
        task,
        snapshot,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "provider_incompatible" }));
  });
});
