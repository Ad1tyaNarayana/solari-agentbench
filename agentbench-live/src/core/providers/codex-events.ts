import type {
  ThreadEvent,
  ThreadItem,
  Usage,
} from "@openai/codex-sdk";
import type { AgentEventKind, ProviderUsage } from "./types";

export type NormalizedCodexEvent = {
  kind: AgentEventKind;
  payload: unknown;
};

function toolName(item: Extract<ThreadItem, { type: "mcp_tool_call" }>): string {
  return `${item.server}.${item.tool}`;
}

function normalizeStartedItem(item: ThreadItem): NormalizedCodexEvent[] {
  switch (item.type) {
    case "command_execution":
      return [
        {
          kind: "tool-request",
          payload: {
            id: item.id,
            tool: "command_execution",
            arguments: { command: item.command },
          },
        },
      ];
    case "mcp_tool_call":
      return [
        {
          kind: "tool-request",
          payload: {
            id: item.id,
            tool: toolName(item),
            arguments: item.arguments,
          },
        },
      ];
    case "web_search":
      return [
        {
          kind: "tool-request",
          payload: {
            id: item.id,
            tool: "web_search",
            arguments: { query: item.query },
          },
        },
      ];
    default:
      return [];
  }
}

function normalizeCompletedItem(item: ThreadItem): NormalizedCodexEvent[] {
  switch (item.type) {
    case "agent_message":
      return [{ kind: "message", payload: { id: item.id, text: item.text } }];
    case "reasoning":
      return [
        {
          kind: "reasoning-summary",
          payload: { id: item.id, text: item.text },
        },
      ];
    case "command_execution":
      return [
        {
          kind: "tool-result",
          payload: {
            id: item.id,
            tool: "command_execution",
            status: item.status,
            result: {
              command: item.command,
              aggregatedOutput: item.aggregated_output,
              ...(item.exit_code === undefined
                ? {}
                : { exitCode: item.exit_code }),
            },
          },
        },
      ];
    case "mcp_tool_call":
      return [
        {
          kind: "tool-result",
          payload: {
            id: item.id,
            tool: toolName(item),
            status: item.status,
            ...(item.result === undefined ? {} : { result: item.result }),
            ...(item.error === undefined ? {} : { error: item.error }),
          },
        },
      ];
    case "web_search":
      return [
        {
          kind: "tool-result",
          payload: {
            id: item.id,
            tool: "web_search",
            status: "completed",
            result: { query: item.query },
          },
        },
      ];
    case "file_change":
      return [
        {
          kind: "artifact",
          payload: {
            id: item.id,
            changes: item.changes,
            status: item.status,
          },
        },
      ];
    case "error":
      return [
        {
          kind: "warning",
          payload: { id: item.id, message: item.message },
        },
      ];
    case "todo_list":
      return [
        {
          kind: "reasoning-summary",
          payload: { id: item.id, items: item.items },
        },
      ];
  }
}

export function normalizeCodexEvent(event: ThreadEvent): NormalizedCodexEvent[] {
  switch (event.type) {
    case "item.started":
      return normalizeStartedItem(event.item);
    case "item.completed":
      return normalizeCompletedItem(event.item);
    case "item.updated":
      return [];
    case "turn.completed":
      return [
        {
          kind: "usage",
          payload: {
            inputTokens: event.usage.input_tokens,
            cachedInputTokens: event.usage.cached_input_tokens,
            cacheWriteInputTokens: event.usage.cache_write_input_tokens,
            outputTokens: event.usage.output_tokens,
            reasoningOutputTokens: event.usage.reasoning_output_tokens,
          },
        },
      ];
    case "turn.failed":
      return [{ kind: "error", payload: { message: event.error.message } }];
    case "error":
      return [{ kind: "error", payload: { message: event.message } }];
    case "thread.started":
    case "turn.started":
      return [];
  }
}

export function codexUsage(
  usage: Usage | null | undefined,
): ProviderUsage | undefined {
  if (usage === null || usage === undefined) return undefined;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  };
}

export function codexEventFailure(event: ThreadEvent): string | undefined {
  if (event.type === "turn.failed") return event.error.message;
  if (event.type === "error") return event.message;
  return undefined;
}

export function codexEventFinalResponse(event: ThreadEvent): string | undefined {
  return event.type === "item.completed" && event.item.type === "agent_message"
    ? event.item.text
    : undefined;
}

export function codexEventUsage(event: ThreadEvent): Usage | undefined {
  return event.type === "turn.completed" ? event.usage : undefined;
}
