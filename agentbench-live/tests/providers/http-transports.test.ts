import { describe, expect, it, vi } from "vitest";
import { AnthropicTransport } from "@/core/providers/transports/anthropic";
import { OpenAICompatibleTransport } from "@/core/providers/transports/openai-compatible";
import type { ModelCompletionInput } from "@/core/providers/transports/types";

const input: ModelCompletionInput = {
  model: "test-model",
  system: "system prompt",
  messages: [{ role: "user", content: "hello" }],
  tools: [{ name: "read", description: "read", inputSchema: { type: "object" } }],
  signal: new AbortController().signal,
};

describe("AnthropicTransport", () => {
  it("sends Messages API auth and normalizes text, tools, and usage", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      content: [
        { type: "thinking", thinking: "private reasoning metadata" },
        { type: "text", text: "checking" },
        { type: "tool_use", id: "tool-1", name: "read", input: { path: "a" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 7, output_tokens: 3 },
    }), { status: 200 }));
    const transport = new AnthropicTransport({ apiKey: "anthropic-secret", fetch });

    const turn = await transport.complete(input);

    expect(fetch).toHaveBeenCalledWith("https://api.anthropic.com/v1/messages", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        "x-api-key": "anthropic-secret",
        "anthropic-version": "2023-06-01",
      }),
      signal: input.signal,
    }));
    const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual(expect.objectContaining({ model: "test-model", system: "system prompt" }));
    expect(body.tools[0]).toEqual(expect.objectContaining({ input_schema: { type: "object" } }));
    expect(turn).toEqual({
      text: "checking",
      toolCalls: [{ id: "tool-1", name: "read", arguments: { path: "a" } }],
      usage: { inputTokens: 7, outputTokens: 3 },
      finishReason: "tool_use",
    });
  });

  it("groups adjacent tool results into one Anthropic user message", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      content: [{ type: "text", text: "done" }], stop_reason: "end_turn",
    }), { status: 200 }));
    const transport = new AnthropicTransport({ apiKey: "secret", fetch });

    await transport.complete({
      ...input,
      messages: [
        { role: "assistant", content: "", toolCalls: [
          { id: "one", name: "read", arguments: { path: "a" } },
          { id: "two", name: "read", arguments: { path: "b" } },
        ] },
        { role: "tool", name: "read", toolCallId: "one", content: '{"ok":true}' },
        { role: "tool", name: "read", toolCallId: "two", content: '{"ok":true}' },
      ],
    });

    const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "one", content: '{"ok":true}' },
        { type: "tool_result", tool_use_id: "two", content: '{"ok":true}' },
      ],
    });
  });
});

describe("OpenAICompatibleTransport", () => {
  it("sends chat completions auth and normalizes tool calls", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "checking", tool_calls: [{
        id: "tool-1", type: "function", function: { name: "read", arguments: '{"path":"a"}' },
      }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 5, completion_tokens: 4 },
    }), { status: 200 }));
    const transport = new OpenAICompatibleTransport({ apiKey: "openai-secret", fetch });

    const turn = await transport.complete(input);

    expect(fetch).toHaveBeenCalledWith("https://api.openai.com/v1/chat/completions", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer openai-secret" }),
      signal: input.signal,
    }));
    expect(turn).toEqual({
      text: "checking",
      toolCalls: [{ id: "tool-1", name: "read", arguments: { path: "a" } }],
      usage: { inputTokens: 5, outputTokens: 4 },
      finishReason: "tool_calls",
    });
  });

  it.each(["http://example.com", "https://api.example.com"])(
    "rejects unsafe or failed endpoint %s without leaking credentials",
    async (baseUrl) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response("server-secret echoed", { status: 401 }));
    const failure = await Promise.resolve()
      .then(() => new OpenAICompatibleTransport({ apiKey: "server-secret", baseUrl, fetch }))
      .then((transport) => transport.complete(input))
      .catch((error: unknown) => error);
    expect(failure).toEqual(expect.objectContaining({
      code: baseUrl.startsWith("http:") ? "provider_incompatible" : "agent_failed",
    }));
    expect(JSON.stringify(failure)).not.toContain("server-secret");
    },
  );
});
