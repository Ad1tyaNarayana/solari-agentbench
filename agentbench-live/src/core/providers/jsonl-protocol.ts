import { z } from "zod";
import { ProviderProtocolError } from "./errors";
import type { AgentEventKind, ProviderExecutionResult } from "./types";

export const EXECUTABLE_JSONL_PROTOCOL_VERSION = 1 as const;
export const EXECUTABLE_JSONL_MAX_LINE_BYTES = 1024 * 1024;

const eventKinds = [
  "message",
  "reasoning-summary",
  "tool-request",
  "tool-result",
  "resource-created",
  "resource-observation",
  "artifact",
  "usage",
  "warning",
  "error",
] as const satisfies readonly AgentEventKind[];

const base = z.object({
  protocolVersion: z.literal(EXECUTABLE_JSONL_PROTOCOL_VERSION),
  type: z.string(),
  requestId: z.string().min(1).max(256).optional(),
}).passthrough();

const executionResult = z.object({
  resolvedModel: z.string().max(1024).optional(),
  usage: z.object({
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
  }).strict().optional(),
  finalResponse: z.string().max(EXECUTABLE_JSONL_MAX_LINE_BYTES).optional(),
}).strict();

export type HarnessMessage =
  | { protocolVersion: 1; type: "initialized"; requestId: string }
  | { protocolVersion: 1; type: "plan_result"; requestId: string; plan: unknown }
  | { protocolVersion: 1; type: "event"; event: { kind: AgentEventKind; payload: unknown } }
  | { protocolVersion: 1; type: "tool_request"; requestId: string; name: string; arguments: unknown }
  | { protocolVersion: 1; type: "result"; requestId: string; result: ProviderExecutionResult }
  | { protocolVersion: 1; type: "error"; requestId?: string; error?: unknown };

export function parseHarnessMessage(line: string): HarnessMessage {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    throw new ProviderProtocolError(
      "Executable JSONL harness emitted malformed JSON",
      "executable-jsonl",
    );
  }
  const parsed = base.safeParse(decoded);
  if (!parsed.success) {
    throw new ProviderProtocolError(
      "Executable JSONL harness emitted an invalid protocol envelope",
      "executable-jsonl",
    );
  }
  const message = parsed.data;
  switch (message.type) {
    case "initialized":
      if (!message.requestId) break;
      return message as HarnessMessage;
    case "plan_result":
      if (!message.requestId || !("plan" in message)) break;
      return message as HarnessMessage;
    case "event": {
      const event = z.object({
        kind: z.enum(eventKinds),
        payload: z.unknown(),
      }).safeParse(message.event);
      if (!event.success) break;
      return { ...message, event: event.data } as HarnessMessage;
    }
    case "tool_request":
      if (
        !message.requestId ||
        typeof message.name !== "string" ||
        message.name.length === 0 ||
        !("arguments" in message)
      ) break;
      return message as HarnessMessage;
    case "result": {
      if (!message.requestId) break;
      const result = executionResult.safeParse(message.result);
      if (!result.success) break;
      return { ...message, result: result.data } as HarnessMessage;
    }
    case "error":
      return message as HarnessMessage;
  }
  throw new ProviderProtocolError(
    `Executable JSONL harness emitted an invalid ${message.type} message`,
    "executable-jsonl",
  );
}

export function platformMessage(
  type: "initialize" | "plan" | "execute" | "tool_result" | "cancel",
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return { protocolVersion: EXECUTABLE_JSONL_PROTOCOL_VERSION, type, ...fields };
}
