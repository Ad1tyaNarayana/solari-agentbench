import type { BenchmarkSnapshot } from "@/core/benchmarks/snapshot";
import type {
  AgentDefinition,
  BenchmarkTaskDefinition,
} from "@/core/benchmarks/types";
import type { RunPlan } from "@/core/domain/plan";
import type { DisposableWorkspace } from "@/core/security/workspace";
import type { AgentEventSink } from "./events";

export type ProviderUsage = {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
};

export type AgentToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/** The policy-bound surface providers may use to act on a run. */
export interface AgentToolBroker {
  listDefinitions(): AgentToolDefinition[];
  invoke(
    name: string,
    argumentsValue: unknown,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export type ProviderPreflightInput = {
  agent: AgentDefinition;
  task: BenchmarkTaskDefinition;
  snapshot: BenchmarkSnapshot;
};

export type ProviderPreflightResult = {
  ok: true;
  warnings?: string[];
};

export type ProviderPlanInput = {
  agent: AgentDefinition;
  task: BenchmarkTaskDefinition;
  snapshot: BenchmarkSnapshot;
  remainingMs(): number;
};

export type ProviderExecutionInput = {
  agent: AgentDefinition;
  task: BenchmarkTaskDefinition;
  snapshot: BenchmarkSnapshot;
  plan: RunPlan;
  workspace: DisposableWorkspace;
  tools: AgentToolBroker;
  remainingMs(): number;
};

export type ProviderRunHandle = { id: string };

export type ProviderExecution = {
  handle: ProviderRunHandle;
  result: Promise<ProviderExecutionResult>;
};

export type AgentProviderDescription = {
  id: string;
  name: string;
  adapterVersion: string;
  capabilities: {
    planning: boolean;
    streaming: boolean;
    tools: boolean;
    structuredCompletion: boolean;
  };
  optionsSchema: Record<string, unknown>;
};

export type ProviderExecutionResult = {
  resolvedModel?: string;
  usage?: ProviderUsage;
  finalResponse?: string;
  nativeTranscript?: string;
};

export interface AgentProvider {
  describe(): AgentProviderDescription;
  preflight(input: ProviderPreflightInput): Promise<ProviderPreflightResult>;
  plan(input: ProviderPlanInput, signal: AbortSignal): Promise<RunPlan>;
  execute(
    input: ProviderExecutionInput,
    sink: AgentEventSink,
    signal: AbortSignal,
  ): Promise<ProviderExecution>;
  cancel(handle: ProviderRunHandle): Promise<void>;
}

export type StructuredCompletionInput = {
  agent: AgentDefinition;
  system: string;
  prompt: string;
  outputSchema: Record<string, unknown>;
  workingDirectory: string;
};

export type StructuredCompletionResult = {
  resolvedModel?: string;
  text: string;
  usage?: ProviderUsage;
  nativeResponse?: unknown;
};

export interface StructuredCompletionProvider {
  completeStructured(
    input: StructuredCompletionInput,
    signal: AbortSignal,
  ): Promise<StructuredCompletionResult>;
}

export type { AgentEvent, AgentEventKind, AgentEventSink } from "./events";
