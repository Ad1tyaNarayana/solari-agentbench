import { z } from "zod";
import { AgentFailedError } from "../errors";
import { endpoint, readJsonResponse } from "./http";
import type { ModelCompletionInput, ModelMessage, ModelTransport, ModelTurn } from "./types";

const responseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        id: z.string().min(1),
        type: z.literal("function"),
        function: z.object({ name: z.string().min(1), arguments: z.string() }),
      }).passthrough()).optional(),
    }).passthrough(),
    finish_reason: z.string().nullable(),
  }).passthrough()).min(1),
  usage: z.object({ prompt_tokens: z.number().nonnegative(), completion_tokens: z.number().nonnegative() }).optional(),
}).passthrough();

function openAiMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCalls ? { tool_calls: message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    })) } : {}),
  };
}

export type OpenAICompatibleTransportOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
};

export class OpenAICompatibleTransport implements ModelTransport {
  readonly #apiKey: string;
  readonly #url: string;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAICompatibleTransportOptions) {
    this.#apiKey = options.apiKey;
    this.#url = endpoint(options.baseUrl ?? "https://api.openai.com/v1", "/chat/completions", "openai-compatible");
    this.#fetch = options.fetch ?? fetch;
  }

  async complete(input: ModelCompletionInput): Promise<ModelTurn> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${this.#apiKey}` },
        body: JSON.stringify({
          model: input.model,
          messages: [
            { role: "system", content: input.system },
            ...input.messages.map(openAiMessage),
          ],
          tools: input.tools.map((tool) => ({
            type: "function",
            function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
          })),
        }),
        signal: input.signal,
      });
    } catch {
      throw new AgentFailedError("openai-compatible request failed", "openai-compatible");
    }
    const parsed = responseSchema.safeParse(await readJsonResponse(response, "openai-compatible"));
    if (!parsed.success) {
      throw new AgentFailedError("openai-compatible returned an invalid response", "openai-compatible");
    }
    const choice = parsed.data.choices[0];
    const toolCalls = [];
    for (const call of choice.message.tool_calls ?? []) {
      let argumentsValue: unknown;
      try {
        argumentsValue = JSON.parse(call.function.arguments);
      } catch {
        throw new AgentFailedError("openai-compatible returned malformed tool arguments", "openai-compatible");
      }
      toolCalls.push({ id: call.id, name: call.function.name, arguments: argumentsValue });
    }
    return {
      text: choice.message.content ?? "",
      toolCalls,
      ...(parsed.data.usage ? { usage: {
        inputTokens: parsed.data.usage.prompt_tokens,
        outputTokens: parsed.data.usage.completion_tokens,
      } } : {}),
      finishReason: choice.finish_reason ?? "unknown",
    };
  }
}
