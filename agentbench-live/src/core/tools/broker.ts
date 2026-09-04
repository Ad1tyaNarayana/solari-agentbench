import type { RunPlan } from "@/core/domain/plan";
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
  allToolContracts,
  type IsolatedWorkspaceCommandRunner,
  parseToolArguments,
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
    const contract = contractsByName.get(name);
    if (contract === undefined) {
      throw new AgentToolError("unknown_tool", `Unknown agent tool: ${name}`, {
        toolName: name,
      });
    }
    signal.throwIfAborted();
    const parsed = parseToolArguments(contract, argumentsValue);
    if (workspaceNames.has(name)) {
      return this.#workspace.invoke(name, parsed, signal);
    }
    return this.#solari.invoke(name, parsed, signal);
  }
}

export function createAgentToolBroker(
  options: CreateAgentToolBrokerOptions,
): AgentToolBroker {
  return new PolicyBoundAgentToolBroker(options);
}
