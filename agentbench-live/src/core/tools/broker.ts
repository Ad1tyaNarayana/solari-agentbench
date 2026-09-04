import type { RunPlan } from "@/core/domain/plan";
import {
  redactCredentialError,
  redactCredentialOutput,
} from "@/core/credentials/redaction";
import type { AgentEventSink } from "@/core/providers/events";
import type {
  AgentToolBroker,
  AgentToolDefinition,
} from "@/core/providers/types";
import type { DisposableWorkspace } from "@/core/security/workspace";
import type { SolariServices } from "@/core/solari/contracts";
import type { ResourceSupervisor } from "@/core/solari/resource-supervisor";
import { SolariTools } from "./solari-tools";
import {
  AgentToolError,
  type AgentToolErrorCode,
  allToolContracts,
  COMMAND_OUTPUT_MAX_BYTES,
  type IsolatedWorkspaceCommandRunner,
  parseToolArguments,
  SCREENSHOT_BASE64_MAX_BYTES,
  TOOL_RESULT_ENVELOPE_MAX_BYTES,
  WORKSPACE_LIST_MAX_BYTES,
  workspaceToolContracts,
} from "./types";
import { WorkspaceTools } from "./workspace-tools";

export type CreateAgentToolBrokerOptions = {
  workspace: DisposableWorkspace;
  plan: RunPlan;
  services: SolariServices;
  supervisor: ResourceSupervisor;
  sink: AgentEventSink;
  remainingMs(): number;
  /** Untrusted or secret-bearing keys are removed before local commands start. */
  environment?: Readonly<Record<string, string | undefined>>;
  workspaceCommandRunner?: IsolatedWorkspaceCommandRunner;
};

const contractsByName = new Map(
  allToolContracts.map((tool) => [tool.definition.name, tool]),
);
const workspaceNames = new Set(
  workspaceToolContracts.map((tool) => tool.definition.name),
);
const executionNames = new Set(["workspace_exec", "sandbox_exec", "desktop_exec"]);
const screenshotNames = new Set(["browser_screenshot", "desktop_screenshot"]);
const agentToolErrorCodes = new Set<AgentToolErrorCode>([
  "unknown_tool",
  "invalid_arguments",
  "path_forbidden",
  "symlink_forbidden",
  "input_limit",
  "output_limit",
  "deadline_exceeded",
  "isolation_unavailable",
  "execution_failed",
  "primitive_not_planned",
  "resource_tracking_failed",
  "unknown_handle",
]);

function serializedBytes(value: unknown, toolName: string): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch (error) {
    throw new AgentToolError("execution_failed", "Tool result is not serializable", {
      toolName,
      cause: error,
    });
  }
}

function sanitizedBoundedResult(name: string, value: unknown): unknown {
  const sanitized = redactCredentialOutput(value);
  let payloadLimit = COMMAND_OUTPUT_MAX_BYTES + TOOL_RESULT_ENVELOPE_MAX_BYTES;

  if (name === "workspace_list") {
    payloadLimit = WORKSPACE_LIST_MAX_BYTES;
  } else if (screenshotNames.has(name)) {
    payloadLimit = SCREENSHOT_BASE64_MAX_BYTES + TOOL_RESULT_ENVELOPE_MAX_BYTES;
    const dataBase64 = (sanitized as { dataBase64?: unknown })?.dataBase64;
    if (
      typeof dataBase64 !== "string" ||
      Buffer.byteLength(dataBase64, "utf8") > SCREENSHOT_BASE64_MAX_BYTES
    ) {
      throw new AgentToolError("output_limit", "Screenshot exceeds encoded byte limit", {
        toolName: name,
      });
    }
  } else if (executionNames.has(name)) {
    const result = sanitized as { stdout?: unknown; stderr?: unknown };
    if (
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string" ||
      Buffer.byteLength(result.stdout, "utf8") +
        Buffer.byteLength(result.stderr, "utf8") >
        COMMAND_OUTPUT_MAX_BYTES
    ) {
      throw new AgentToolError("output_limit", "Command output exceeds byte limit", {
        toolName: name,
      });
    }
  } else if (name === "browser_text" || name === "workspace_read") {
    const field = name === "browser_text" ? "text" : "content";
    const text = (sanitized as Record<string, unknown>)?.[field];
    if (
      typeof text === "string" &&
      Buffer.byteLength(text, "utf8") > COMMAND_OUTPUT_MAX_BYTES
    ) {
      throw new AgentToolError("output_limit", "Tool text exceeds byte limit", {
        toolName: name,
      });
    }
  }

  if (serializedBytes(sanitized, name) > payloadLimit) {
    throw new AgentToolError("output_limit", "Tool result exceeds serialized byte limit", {
      toolName: name,
    });
  }
  return sanitized;
}

function copyDefinition(definition: AgentToolDefinition): AgentToolDefinition {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: structuredClone(definition.inputSchema),
  };
}

export class PolicyBoundAgentToolBroker implements AgentToolBroker {
  readonly #workspace: WorkspaceTools;
  readonly #solari: SolariTools;
  #invocationTail: Promise<void> = Promise.resolve();

  constructor(options: CreateAgentToolBrokerOptions) {
    this.#workspace = new WorkspaceTools({
      workspace: options.workspace,
      remainingMs: options.remainingMs,
      environment: options.environment,
      commandRunner: options.workspaceCommandRunner,
    });
    this.#solari = new SolariTools({
      plan: options.plan,
      services: options.services,
      supervisor: options.supervisor,
      sink: options.sink,
      remainingMs: options.remainingMs,
    });
  }

  listDefinitions(): AgentToolDefinition[] {
    return allToolContracts.map(({ definition }) => copyDefinition(definition));
  }

  invoke(
    name: string,
    argumentsValue: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const invocation = this.#invocationTail.then(() =>
      this.#invokeSerially(name, argumentsValue, signal),
    );
    this.#invocationTail = invocation.then(
      () => undefined,
      () => undefined,
    );
    return invocation;
  }

  async #invokeSerially(
    name: string,
    argumentsValue: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    try {
      const contract = contractsByName.get(name);
      if (contract === undefined) {
        throw new AgentToolError("unknown_tool", `Unknown agent tool: ${name}`, {
          toolName: name,
        });
      }
      signal.throwIfAborted();
      const parsed = parseToolArguments(contract, argumentsValue);
      if (workspaceNames.has(name)) {
        return sanitizedBoundedResult(
          name,
          await this.#workspace.invoke(name, parsed, signal),
        );
      }
      return sanitizedBoundedResult(
        name,
        await this.#solari.invoke(name, parsed, signal),
      );
    } catch (error) {
      const sanitized = redactCredentialError(error);
      if (error instanceof AgentToolError && sanitized instanceof Error) {
        const safe = sanitized as Error & {
          code?: unknown;
          toolName?: unknown;
          cause?: unknown;
        };
        const code =
          typeof safe.code === "string" &&
          agentToolErrorCodes.has(safe.code as AgentToolErrorCode)
            ? safe.code as AgentToolErrorCode
            : "execution_failed";
        throw new AgentToolError(code, safe.message, {
          ...(typeof safe.toolName === "string" ? { toolName: safe.toolName } : {}),
          ...(Object.hasOwn(safe, "cause") ? { cause: safe.cause } : {}),
        });
      }
      throw new AgentToolError("execution_failed", "Agent tool invocation failed", {
        toolName: name,
        cause: sanitized,
      });
    }
  }
}

export function createAgentToolBroker(
  options: CreateAgentToolBrokerOptions,
): AgentToolBroker {
  return new PolicyBoundAgentToolBroker(options);
}
