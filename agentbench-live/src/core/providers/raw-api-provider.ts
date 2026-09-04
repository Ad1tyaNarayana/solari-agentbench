import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentDefinition } from "@/core/benchmarks/types";
import type { CredentialStore } from "@/core/credentials/types";
import { RunPlanSchema, runPlanOutputJsonSchema, validatePlanForTask, type RunPlan } from "@/core/domain/plan";
import { runModelToolLoop } from "./model-loop";
import {
  AgentFailedError,
  CredentialMissingError,
  ProviderIncompatibleError,
  ProviderPlanInvalidError,
} from "./errors";
import { AnthropicTransport } from "./transports/anthropic";
import { OpenAICompatibleTransport } from "./transports/openai-compatible";
import type { ModelTransport } from "./transports/types";
import type {
  AgentEventSink,
  AgentProvider,
  AgentProviderDescription,
  ProviderExecution,
  ProviderExecutionInput,
  ProviderExecutionResult,
  ProviderPlanInput,
  ProviderPreflightInput,
  ProviderPreflightResult,
  ProviderRunHandle,
  StructuredCompletionInput,
  StructuredCompletionProvider,
  StructuredCompletionResult,
} from "./types";

type ActiveExecution = { controller: AbortController; result?: Promise<ProviderExecutionResult> };

export type RawApiProviderOptions = {
  id: string;
  credentials: CredentialStore;
  createTransport(apiKey: string, agent: AgentDefinition): ModelTransport;
  createHandleId?: () => string;
};

function requiredModel(agent: AgentDefinition, providerId: string): string {
  const model = agent.model?.trim();
  if (!model) throw new ProviderIncompatibleError(providerId, `${providerId} agents must declare a model`);
  return model;
}

function requiredCredential(agent: AgentDefinition, providerId: string): string {
  const credential = agent.credential?.trim();
  if (!credential) {
    throw new ProviderIncompatibleError(providerId, `${providerId} agents must declare a credential reference`);
  }
  return credential;
}

function validatePlan(value: unknown, input: ProviderPlanInput | ProviderExecutionInput, providerId: string): RunPlan {
  const parsed = RunPlanSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProviderPlanInvalidError(`${providerId} produced an invalid run plan`, providerId);
  }
  try {
    return validatePlanForTask(parsed.data, input.task);
  } catch (error) {
    throw new ProviderPlanInvalidError(
      error instanceof Error ? error.message : `${providerId} plan is not allowed`,
      providerId,
    );
  }
}

function planningPrompt(input: ProviderPlanInput): string {
  return [
    `Plan benchmark task ${input.task.id}.`,
    `Allowed primitives: ${input.task.allowedPrimitives.join(", ")}.`,
    `Return only JSON matching this schema: ${JSON.stringify(runPlanOutputJsonSchema())}`,
    "Task prompt:",
    input.task.prompt,
  ].join("\n");
}

function executionSystem(input: ProviderExecutionInput): string {
  return [
    "Complete the immutable benchmark task using only the declared tools.",
    `Approved run plan: ${JSON.stringify(input.plan)}`,
    `Write the final submission under ${input.task.submission.directory}.`,
  ].join("\n");
}

function parseJson(text: string, message: string, providerId: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new AgentFailedError(message, providerId);
  }
}

export class RawApiProvider implements AgentProvider, StructuredCompletionProvider {
  readonly #id: string;
  readonly #credentials: CredentialStore;
  readonly #createTransport: RawApiProviderOptions["createTransport"];
  readonly #createHandleId: () => string;
  readonly #active = new Map<string, ActiveExecution>();

  constructor(options: RawApiProviderOptions) {
    this.#id = options.id;
    this.#credentials = options.credentials;
    this.#createTransport = options.createTransport;
    this.#createHandleId = options.createHandleId ?? randomUUID;
  }

  describe(): AgentProviderDescription {
    return {
      id: this.#id,
      name: this.#id === "anthropic" ? "Anthropic" : "OpenAI-compatible",
      adapterVersion: "1.0.0",
      capabilities: { planning: true, streaming: false, tools: true, structuredCompletion: true },
      optionsSchema: {
        type: "object",
        properties: { baseUrl: { type: "string", format: "uri" } },
        additionalProperties: false,
      },
    };
  }

  async preflight(input: ProviderPreflightInput): Promise<ProviderPreflightResult> {
    if (input.agent.provider.toLowerCase() !== this.#id) {
      throw new ProviderIncompatibleError(this.#id, `${this.#id} provider cannot run agent ${input.agent.id}`);
    }
    requiredModel(input.agent, this.#id);
    const credential = requiredCredential(input.agent, this.#id);
    if (!(await this.#credentials.has(credential))) {
      throw new CredentialMissingError(credential, this.#id);
    }
    return { ok: true };
  }

  async #withTransport<T>(agent: AgentDefinition, use: (transport: ModelTransport) => Promise<T>): Promise<T> {
    const ref = requiredCredential(agent, this.#id);
    return this.#credentials.withCredential(ref, async (secret) =>
      use(this.#createTransport(secret.reveal(), agent)));
  }

  async plan(input: ProviderPlanInput, signal: AbortSignal): Promise<RunPlan> {
    signal.throwIfAborted();
    const model = requiredModel(input.agent, this.#id);
    return this.#withTransport(input.agent, async (transport) => {
      const turn = await transport.complete({
        model,
        system: "Select the minimum benchmark resources needed. Return only the requested JSON.",
        messages: [{ role: "user", content: planningPrompt(input) }],
        tools: [],
        signal,
      });
      return validatePlan(parseJson(
        turn.text,
        `${this.#id} planning returned malformed JSON`,
        this.#id,
      ), input, this.#id);
    });
  }

  async execute(
    input: ProviderExecutionInput,
    sink: AgentEventSink,
    signal: AbortSignal,
  ): Promise<ProviderExecution> {
    signal.throwIfAborted();
    const plan = validatePlan(input.plan, input, this.#id);
    const model = requiredModel(input.agent, this.#id);
    const handle: ProviderRunHandle = { id: this.#createHandleId() };
    if (this.#active.has(handle.id)) {
      throw new AgentFailedError(`${this.#id} execution handle collision`, this.#id);
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const active: ActiveExecution = { controller };
    this.#active.set(handle.id, active);
    const result = this.#withTransport(input.agent, async (transport) => {
      const loop = await runModelToolLoop({
        transport,
        model,
        system: executionSystem({ ...input, plan }),
        prompt: input.task.prompt,
        tools: input.tools.listDefinitions(),
        broker: input.tools,
        sink,
        signal: controller.signal,
        remainingMs: input.remainingMs,
        workspaceRoot: input.workspace.root,
        submissionDirectory: input.task.submission.directory,
      });
      return { resolvedModel: model, ...loop };
    }).catch((error: unknown) => {
      if (error instanceof AgentFailedError) throw error;
      throw new AgentFailedError(`${this.#id} execution failed`, this.#id);
    }).finally(() => {
      signal.removeEventListener("abort", abort);
      this.#active.delete(handle.id);
    });
    active.result = result;
    return { handle, result };
  }

  async cancel(handle: ProviderRunHandle): Promise<void> {
    const active = this.#active.get(handle.id);
    if (!active) return;
    active.controller.abort(new Error(`${this.#id} execution cancelled`));
    try {
      await active.result;
    } catch {
      // Cancellation waits for the transport to observe abort, not for success.
    }
  }

  async completeStructured(
    input: StructuredCompletionInput,
    signal: AbortSignal,
  ): Promise<StructuredCompletionResult> {
    signal.throwIfAborted();
    const model = requiredModel(input.agent, this.#id);
    return this.#withTransport(input.agent, async (transport) => {
      const turn = await transport.complete({
        model,
        system: input.system,
        messages: [{
          role: "user",
          content: `${input.prompt}\n\nReturn only JSON matching: ${JSON.stringify(input.outputSchema)}`,
        }],
        tools: [],
        signal,
      });
      const decoded = parseJson(
        turn.text,
        `${this.#id} structured completion returned malformed JSON`,
        this.#id,
      );
      try {
        const parsed = z.fromJSONSchema(input.outputSchema as never).safeParse(decoded);
        if (!parsed.success) throw new Error("schema mismatch");
        return {
          resolvedModel: model,
          text: turn.text,
          usage: turn.usage,
          nativeResponse: parsed.data,
        };
      } catch {
        throw new AgentFailedError(`${this.#id} structured completion failed validation`, this.#id);
      }
    });
  }
}

function baseUrl(agent: AgentDefinition): string | undefined {
  const value = agent.options.baseUrl;
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ProviderIncompatibleError(agent.provider, "baseUrl must be a string");
  }
  return value;
}

export function createAnthropicProvider(
  credentials: CredentialStore,
  transportFetch?: typeof fetch,
): RawApiProvider {
  return new RawApiProvider({
    id: "anthropic",
    credentials,
    createTransport: (apiKey, agent) => new AnthropicTransport({
      apiKey,
      baseUrl: baseUrl(agent),
      fetch: transportFetch,
    }),
  });
}

export function createOpenAICompatibleProvider(
  credentials: CredentialStore,
  transportFetch?: typeof fetch,
): RawApiProvider {
  return new RawApiProvider({
    id: "openai-compatible",
    credentials,
    createTransport: (apiKey, agent) => new OpenAICompatibleTransport({
      apiKey,
      baseUrl: baseUrl(agent),
      fetch: transportFetch,
    }),
  });
}
