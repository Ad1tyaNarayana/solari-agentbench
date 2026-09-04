import type { AgentToolDefinition } from "../types";

export type ModelToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

export type ModelMessage =
  | { role: "user" | "assistant"; content: string; toolCalls?: ModelToolCall[] }
  | { role: "tool"; content: string; toolCallId: string; name: string };

export type ModelCompletionInput = {
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: AgentToolDefinition[];
  signal: AbortSignal;
};

export type ModelTurn = {
  text: string;
  toolCalls: ModelToolCall[];
  usage?: { inputTokens?: number; outputTokens?: number };
  finishReason: string;
};

export interface ModelTransport {
  complete(input: ModelCompletionInput): Promise<ModelTurn>;
}
