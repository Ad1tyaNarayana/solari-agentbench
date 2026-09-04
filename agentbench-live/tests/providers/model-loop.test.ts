import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentEventSink, type AgentEvent } from "@/core/providers/events";
import {
  MODEL_LOOP_MAX_TOOL_CALLS,
  MODEL_LOOP_MAX_TURNS,
  runModelToolLoop,
} from "@/core/providers/model-loop";
import type { AgentToolDefinition } from "@/core/providers/types";
import type { ModelTransport, ModelTurn } from "@/core/providers/transports/types";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentbench-model-loop-"));
  roots.push(root);
  await mkdir(join(root, "submission"));
  return root;
}

function sink() {
  const events: AgentEvent[] = [];
  return {
    events,
    value: createAgentEventSink({
      provider: "raw",
      redact: (value) => value,
      publish: (event) => events.push(event),
      now: () => "2026-09-04T00:00:00.000Z",
    }),
  };
}

const tool: AgentToolDefinition = {
  name: "workspace_read",
  description: "read a file",
  inputSchema: { type: "object" },
};

describe("runModelToolLoop", () => {
  it("returns a final response and normalized aggregate usage", async () => {
    const transport: ModelTransport = {
      complete: vi.fn(async () => ({
        text: "finished",
        toolCalls: [],
        usage: { inputTokens: 3, outputTokens: 2 },
        finishReason: "stop",
      })),
    };
    const output = sink();

    const result = await runModelToolLoop({
      transport,
      model: "model-1",
      system: "system",
      prompt: "prompt",
      tools: [],
      broker: { listDefinitions: () => [], invoke: async () => undefined },
      sink: output.value,
      signal: new AbortController().signal,
      remainingMs: () => 10_000,
      workspaceRoot: await workspace(),
      submissionDirectory: "submission",
    });

    expect(result).toEqual({
      finalResponse: "finished",
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    expect(output.events.map((event) => event.kind)).toEqual(["message", "usage"]);
  });

  it("executes tool calls in declaration order and returns typed results", async () => {
    const turns: ModelTurn[] = [
      {
        text: "checking",
        toolCalls: [
          { id: "one", name: "workspace_read", arguments: { path: "one" } },
          { id: "two", name: "workspace_read", arguments: { path: "two" } },
        ],
        finishReason: "tool_calls",
      },
      { text: "done", toolCalls: [], finishReason: "stop" },
    ];
    const transport: ModelTransport = { complete: vi.fn(async () => turns.shift()!) };
    const invocationOrder: string[] = [];
    const output = sink();

    await runModelToolLoop({
      transport,
      model: "model-1",
      system: "system",
      prompt: "prompt",
      tools: [tool],
      broker: {
        listDefinitions: () => [tool],
        invoke: async (_name, args) => {
          invocationOrder.push((args as { path: string }).path);
          return { ok: true };
        },
      },
      sink: output.value,
      signal: new AbortController().signal,
      remainingMs: () => 10_000,
      workspaceRoot: await workspace(),
      submissionDirectory: "submission",
    });

    expect(invocationOrder).toEqual(["one", "two"]);
    expect(output.events.map((event) => event.kind)).toEqual([
      "message", "tool-request", "tool-result", "tool-request", "tool-result", "message",
    ]);
    expect(transport.complete).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "tool", toolCallId: "one" }),
          expect.objectContaining({ role: "tool", toolCallId: "two" }),
        ]),
      }),
    );
  });

  it("rejects unknown and duplicate tool call IDs before broker execution", async () => {
    const invoke = vi.fn(async () => undefined);
    const root = await workspace();
    for (const toolCalls of [
      [{ id: "one", name: "unknown", arguments: {} }],
      [
        { id: "same", name: "workspace_read", arguments: {} },
        { id: "same", name: "workspace_read", arguments: {} },
      ],
    ]) {
      const transport: ModelTransport = {
        complete: async () => ({ text: "", toolCalls, finishReason: "tool_calls" }),
      };
      await expect(runModelToolLoop({
        transport, model: "model-1", system: "system", prompt: "prompt", tools: [tool],
        broker: { listDefinitions: () => [tool], invoke }, sink: sink().value,
        signal: new AbortController().signal, remainingMs: () => 10_000,
        workspaceRoot: root, submissionDirectory: "submission",
      })).rejects.toEqual(expect.objectContaining({ code: "agent_failed" }));
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("enforces turn and tool-call limits", async () => {
    expect(MODEL_LOOP_MAX_TURNS).toBe(100);
    expect(MODEL_LOOP_MAX_TOOL_CALLS).toBe(500);
    const root = await workspace();
    const endless: ModelTransport = {
      complete: async () => ({ text: "", toolCalls: [], finishReason: "length" }),
    };
    await expect(runModelToolLoop({
      transport: endless, model: "model-1", system: "system", prompt: "prompt", tools: [],
      broker: { listDefinitions: () => [], invoke: async () => undefined }, sink: sink().value,
      signal: new AbortController().signal, remainingMs: () => 10_000,
      workspaceRoot: root, submissionDirectory: "submission",
    })).rejects.toEqual(expect.objectContaining({ code: "agent_failed" }));

    const tooMany = Array.from({ length: 501 }, (_, index) => ({
      id: `call-${index}`, name: "workspace_read", arguments: {},
    }));
    await expect(runModelToolLoop({
      transport: { complete: async () => ({ text: "", toolCalls: tooMany, finishReason: "tool_calls" }) },
      model: "model-1", system: "system", prompt: "prompt", tools: [tool],
      broker: { listDefinitions: () => [tool], invoke: async () => undefined }, sink: sink().value,
      signal: new AbortController().signal, remainingMs: () => 10_000,
      workspaceRoot: root, submissionDirectory: "submission",
    })).rejects.toEqual(expect.objectContaining({ code: "agent_failed" }));
  });

  it("does not publish a tool result after an aborted broker call", async () => {
    const controller = new AbortController();
    const output = sink();
    const transport: ModelTransport = {
      complete: async () => ({
        text: "", finishReason: "tool_calls",
        toolCalls: [{ id: "one", name: "workspace_read", arguments: {} }],
      }),
    };
    const running = runModelToolLoop({
      transport, model: "model-1", system: "system", prompt: "prompt", tools: [tool],
      broker: {
        listDefinitions: () => [tool],
        invoke: async () => await new Promise((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
        }),
      },
      sink: output.value, signal: controller.signal, remainingMs: () => 10_000,
      workspaceRoot: await workspace(), submissionDirectory: "submission",
    });
    await vi.waitFor(() => expect(output.events.map((event) => event.kind)).toEqual(["tool-request"]));

    controller.abort(new Error("cancelled"));

    await expect(running).rejects.toThrow("cancelled");
    expect(output.events.map((event) => event.kind)).toEqual(["tool-request"]);
  });
});
