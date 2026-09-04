import { stat } from "node:fs/promises";
import { join } from "node:path";
import { AgentFailedError } from "./errors";
import type { AgentEventSink, AgentToolBroker, AgentToolDefinition, ProviderUsage } from "./types";
import type { ModelMessage, ModelTransport } from "./transports/types";

export const MODEL_LOOP_MAX_TURNS = 100;
export const MODEL_LOOP_MAX_TOOL_CALLS = 500;

export type RunModelToolLoopInput = {
  transport: ModelTransport;
  model: string;
  system: string;
  prompt: string;
  tools: AgentToolDefinition[];
  broker: AgentToolBroker;
  sink: AgentEventSink;
  signal: AbortSignal;
  remainingMs(): number;
  workspaceRoot: string;
  submissionDirectory: string;
};

function addUsage(total: ProviderUsage, addition: ProviderUsage | undefined): void {
  if (addition?.inputTokens !== undefined) {
    total.inputTokens = (total.inputTokens ?? 0) + addition.inputTokens;
  }
  if (addition?.outputTokens !== undefined) {
    total.outputTokens = (total.outputTokens ?? 0) + addition.outputTokens;
  }
}

async function requireSubmission(input: RunModelToolLoopInput): Promise<void> {
  try {
    const info = await stat(join(input.workspaceRoot, input.submissionDirectory));
    if (!info.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new AgentFailedError(
      `Agent did not create submission directory ${input.submissionDirectory}`,
      "raw-api",
    );
  }
}

export async function runModelToolLoop(
  input: RunModelToolLoopInput,
): Promise<{ finalResponse: string; usage?: ProviderUsage }> {
  const messages: ModelMessage[] = [{ role: "user", content: input.prompt }];
  const knownTools = new Set(input.tools.map((tool) => tool.name));
  const callIds = new Set<string>();
  const usage: ProviderUsage = {};
  let callCount = 0;

  for (let turnIndex = 0; turnIndex < MODEL_LOOP_MAX_TURNS; turnIndex += 1) {
    input.signal.throwIfAborted();
    if (input.remainingMs() <= 0) {
      throw new AgentFailedError("Raw model execution exceeded its deadline", "raw-api");
    }
    const turn = await input.transport.complete({
      model: input.model,
      system: input.system,
      messages: [...messages],
      tools: input.tools,
      signal: input.signal,
    });
    if (turn.text.length > 0) await input.sink.emit("message", { text: turn.text });
    if (turn.usage !== undefined) {
      addUsage(usage, turn.usage);
      await input.sink.emit("usage", turn.usage);
    }
    messages.push({
      role: "assistant",
      content: turn.text,
      ...(turn.toolCalls.length > 0 ? { toolCalls: turn.toolCalls } : {}),
    });

    if (turn.toolCalls.length === 0) {
      if (["stop", "end_turn", "completed"].includes(turn.finishReason)) {
        await requireSubmission(input);
        return {
          finalResponse: turn.text,
          ...(Object.keys(usage).length > 0 ? { usage } : {}),
        };
      }
      continue;
    }

    if (callCount + turn.toolCalls.length > MODEL_LOOP_MAX_TOOL_CALLS) {
      throw new AgentFailedError("Raw model execution exceeded 500 tool calls", "raw-api");
    }
    for (const call of turn.toolCalls) {
      if (!knownTools.has(call.name)) {
        throw new AgentFailedError(`Raw model requested unknown tool ${call.name}`, "raw-api");
      }
      if (callIds.has(call.id)) {
        throw new AgentFailedError("Raw model reused a tool call ID", "raw-api");
      }
      callIds.add(call.id);
    }

    for (const call of turn.toolCalls) {
      callCount += 1;
      await input.sink.emit("tool-request", {
        id: call.id,
        tool: call.name,
        arguments: call.arguments,
      });
      let content: string;
      try {
        const result = await input.broker.invoke(call.name, call.arguments, input.signal);
        content = JSON.stringify({ ok: true, result });
        await input.sink.emit("tool-result", { id: call.id, tool: call.name, result });
      } catch {
        input.signal.throwIfAborted();
        content = JSON.stringify({ ok: false, error: { message: "Tool execution failed" } });
        await input.sink.emit("tool-result", {
          id: call.id,
          tool: call.name,
          error: { message: "Tool execution failed" },
        });
      }
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content,
      });
    }
  }
  throw new AgentFailedError("Raw model execution exceeded 100 turns", "raw-api");
}
