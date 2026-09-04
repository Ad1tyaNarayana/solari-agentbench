import { z } from "zod";
import { AgentFailedError } from "../errors";
import { endpoint, readJsonResponse } from "./http";
import type { ModelCompletionInput, ModelMessage, ModelTransport, ModelTurn } from "./types";

const responseSchema = z.object({
  content: z.array(z.object({ type: z.string() }).passthrough()),
  stop_reason: z.string().nullable(),
  usage: z.object({ input_tokens: z.number().nonnegative(), output_tokens: z.number().nonnegative() }).optional(),
}).passthrough();

function anthropicNonToolMessage(message: Exclude<ModelMessage, { role: "tool" }>): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = message.content.length > 0
    ? [{ type: "text", text: message.content }]
    : [];
  for (const call of message.toolCalls ?? []) {
    content.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
  }
  return { role: message.role, content };
}

function anthropicMessages(messages: ModelMessage[]): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  let toolResults: Array<Record<string, unknown>> = [];
  const flushToolResults = () => {
    if (toolResults.length === 0) return;
    output.push({ role: "user", content: toolResults });
    toolResults = [];
  };
  for (const message of messages) {
    if (message.role === "tool") {
      toolResults.push({
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
      });
    } else {
      flushToolResults();
      output.push(anthropicNonToolMessage(message));
    }
  }
  flushToolResults();
  return output;
}

export type AnthropicTransportOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
};

export class AnthropicTransport implements ModelTransport {
  readonly #apiKey: string;
  readonly #url: string;
  readonly #fetch: typeof fetch;

  constructor(options: AnthropicTransportOptions) {
    this.#apiKey = options.apiKey;
    this.#url = endpoint(options.baseUrl ?? "https://api.anthropic.com", "/v1/messages", "anthropic");
    this.#fetch = options.fetch ?? fetch;
  }

  async complete(input: ModelCompletionInput): Promise<ModelTurn> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.#apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: input.model,
          max_tokens: 4096,
          system: input.system,
          messages: anthropicMessages(input.messages),
          tools: input.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
        }),
        signal: input.signal,
      });
    } catch {
      throw new AgentFailedError("anthropic request failed", "anthropic");
    }
    const parsed = responseSchema.safeParse(await readJsonResponse(response, "anthropic"));
    if (!parsed.success) throw new AgentFailedError("anthropic returned an invalid response", "anthropic");
    const text: string[] = [];
    const toolCalls: ModelTurn["toolCalls"] = [];
    for (const item of parsed.data.content) {
      if (item.type === "text") {
        if (typeof item.text !== "string") {
          throw new AgentFailedError("anthropic returned an invalid text block", "anthropic");
        }
        text.push(item.text);
      } else if (item.type === "tool_use") {
        const toolUse = z.object({
          id: z.string().min(1), name: z.string().min(1), input: z.unknown(),
        }).safeParse(item);
        if (!toolUse.success) {
          throw new AgentFailedError("anthropic returned an invalid tool block", "anthropic");
        }
        toolCalls.push({
          id: toolUse.data.id,
          name: toolUse.data.name,
          arguments: toolUse.data.input,
        });
      }
    }
    return {
      text: text.join(""),
      toolCalls,
      ...(parsed.data.usage ? { usage: {
        inputTokens: parsed.data.usage.input_tokens,
        outputTokens: parsed.data.usage.output_tokens,
      } } : {}),
      finishReason: parsed.data.stop_reason ?? "unknown",
    };
  }
}
