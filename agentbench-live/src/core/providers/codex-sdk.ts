import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  Codex,
  type CodexOptions,
  type Input,
  type ModelReasoningEffort,
  type RunResult,
  type RunStreamedResult,
  type ThreadOptions,
  type TurnOptions,
} from "@openai/codex-sdk";
import { z } from "zod";
import { safeChildEnvironment } from "@/core/agents/process";
import type {
  AgentDefinition,
  BenchmarkTaskDefinition,
} from "@/core/benchmarks/types";
import type { CredentialStore } from "@/core/credentials/types";
import {
  RunPlanSchema,
  runPlanOutputJsonSchema,
  validatePlanForTask,
  type Primitive,
  type RunPlan,
} from "@/core/domain/plan";
import { redact } from "@/core/security/redact";
import {
  AgentFailedError,
  CredentialMissingError,
  ProviderIncompatibleError,
  ProviderPlanInvalidError,
} from "./errors";
import {
  codexEventFailure,
  codexEventFinalResponse,
  codexEventUsage,
  codexUsage,
  normalizeCodexEvent,
} from "./codex-events";
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

export interface CodexThreadClient {
  run(input: Input, turnOptions?: TurnOptions): Promise<RunResult>;
  runStreamed(
    input: Input,
    turnOptions?: TurnOptions,
  ): Promise<RunStreamedResult>;
}

export interface CodexClient {
  startThread(options?: ThreadOptions): CodexThreadClient;
}

export type CodexSdkProviderOptions = {
  createCodex?: (options: CodexOptions) => CodexClient;
  environment?: () => Readonly<Record<string, string | undefined>>;
  credentials?: CredentialStore;
  createHandleId?: () => string;
  solariGuardPath?: string;
};

const modelReasoningEfforts = new Set<ModelReasoningEffort>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "persistent",
]);

const solariToolAllowlists: Record<Primitive, readonly string[]> = {
  browser: [
    "solari_browser_create",
    "solari_browser_profiles",
    "solari_browser_autologin_status",
    "solari_browser_autologin_site",
    "solari_browser_login",
    "solari_browser_save_profile",
    "solari_browser_await_login",
    "solari_browser_navigate",
    "solari_browser_read_page",
    "solari_browser_screenshot",
    "solari_browser_click",
    "solari_browser_type",
    "solari_browser_key",
    "solari_browser_evaluate",
    "solari_browser_replay_url",
    "solari_browser_close",
  ],
  sandbox: [
    "solari_sandbox_create",
    "solari_list",
    "solari_kill",
    "solari_connect",
    "solari_exec",
    "solari_run_command_bg",
    "solari_run_code",
    "solari_read_file",
    "solari_write_file",
    "solari_list_files",
    "solari_get_preview_url",
  ],
  desktop: [
    "solari_desktop_create",
    "solari_list",
    "solari_kill",
    "solari_connect",
    "solari_exec",
    "solari_run_command_bg",
    "solari_run_code",
    "solari_read_file",
    "solari_write_file",
    "solari_list_files",
    "solari_get_preview_url",
    "solari_screenshot",
    "solari_click",
    "solari_type",
    "solari_key",
    "solari_open_app",
  ],
};

const solariCreateTools: Record<Primitive, string> = {
  browser: "solari_browser_create",
  sandbox: "solari_sandbox_create",
  desktop: "solari_desktop_create",
};

type PlanTask = Pick<
  BenchmarkTaskDefinition,
  "id" | "prompt" | "allowedPrimitives"
> & { compatibility?: BenchmarkTaskDefinition["compatibility"] };

type ActiveExecution = {
  controller: AbortController;
  result: Promise<ProviderExecutionResult>;
};

function requiredModel(agent: AgentDefinition): string {
  const model = agent.model?.trim();
  if (!model) {
    throw new ProviderIncompatibleError(
      "codex",
      "Codex agents must declare a model",
    );
  }
  return model;
}

function reasoningEffort(
  agent: AgentDefinition,
): ModelReasoningEffort | undefined {
  if (agent.reasoningEffort === undefined) return undefined;
  if (!modelReasoningEfforts.has(agent.reasoningEffort as ModelReasoningEffort)) {
    throw new ProviderIncompatibleError(
      "codex",
      "Codex agent reasoningEffort is unsupported",
    );
  }
  return agent.reasoningEffort as ModelReasoningEffort;
}

function explicitEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function planningEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return explicitEnvironment(safeChildEnvironment(source));
}

function executionEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return explicitEnvironment(
    safeChildEnvironment(source, {
      SOLARI_API_KEY: source.SOLARI_API_KEY,
    }),
  );
}

function threadOptions(
  agent: AgentDefinition,
  workingDirectory: string,
  sandboxMode: "read-only" | "workspace-write",
): ThreadOptions {
  return {
    model: requiredModel(agent),
    modelReasoningEffort: reasoningEffort(agent),
    sandboxMode,
    workingDirectory,
    skipGitRepoCheck: true,
    approvalPolicy: "never",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
  };
}

export function buildCodexPlanningPrompt(task: PlanTask): string {
  const requiredEvidence = task.compatibility?.requiredEvidence ?? [];
  return [
    `Choose the Solari primitives for task ${task.id}.`,
    `Allowed primitives: ${task.allowedPrimitives.join(", ")}.`,
    ...(requiredEvidence.length === 0
      ? []
      : [`Required verifier evidence: ${requiredEvidence.join(", ")}.`]),
    "Use the immutable task prompt below when deciding what is required:",
    task.prompt,
    "Explain every selected primitive and state the verification strategy.",
  ].join("\n");
}

export function buildLegacyCodexExecutionPrompt(
  taskPrompt: string,
  plan: RunPlan,
): string {
  return `${taskPrompt}\n\nApproved RunPlan:\n${JSON.stringify(plan, null, 2)}\n\nCreate the mandatory submission files first, in the fewest write operations possible: submission/results.json, submission/methodology.md, submission/provenance.json, and all task-required source and dependency files. Do not verify or polish until every required file exists and results.json contains valid JSON. Then use only the remaining time for targeted checks. Write the complete final submission under submission/.`;
}

export function parseCodexRunPlan(response: string, task: PlanTask): RunPlan {
  let decoded: unknown;
  try {
    decoded = JSON.parse(response);
  } catch {
    throw new ProviderPlanInvalidError(
      "Codex produced malformed run-plan JSON",
      "codex",
    );
  }
  return validateCodexRunPlan(decoded, task);
}

export function validateCodexRunPlan(
  plan: unknown,
  task: PlanTask,
): RunPlan {
  const parsed = RunPlanSchema.safeParse(plan);
  if (!parsed.success) {
    throw new ProviderPlanInvalidError(
      `Codex produced an invalid run plan: ${parsed.error.message}`,
      "codex",
    );
  }
  try {
    return validatePlanForTask(parsed.data, task);
  } catch (error) {
    throw new ProviderPlanInvalidError(
      error instanceof Error ? error.message : "Codex produced an invalid run plan",
      "codex",
    );
  }
}

export function solariToolsForPrimitives(primitives: Primitive[]): string[] {
  const tools: string[] = [];
  const seen = new Set<string>();
  for (const primitive of primitives) {
    for (const tool of solariToolAllowlists[primitive]) {
      if (!seen.has(tool)) {
        seen.add(tool);
        tools.push(tool);
      }
    }
  }
  return tools;
}

export function solariPrimitivesForTool(toolName: string): Primitive[] {
  const normalized = toolName.startsWith("solari_")
    ? toolName
    : `solari_${toolName}`;
  return (Object.entries(solariToolAllowlists) as Array<
    [Primitive, readonly string[]]
  >)
    .filter(([, tools]) => tools.includes(normalized))
    .map(([primitive]) => primitive);
}

export function solariMcpServerDefinition(
  primitives: Primitive[],
  guardPath: string,
) {
  return {
    command: process.execPath,
    args: [
      guardPath,
      primitives.map((primitive) => solariCreateTools[primitive]).join(","),
      "npx",
      "-y",
      "@solarisdk/mcp@0.4.3",
    ],
    enabled_tools: solariToolsForPrimitives(primitives),
  };
}

function structuredPrompt(input: StructuredCompletionInput): string {
  return `${input.system}\n\n${input.prompt}`;
}

function validateStructuredResponse(
  response: string,
  outputSchema: Record<string, unknown>,
): unknown {
  let decoded: unknown;
  try {
    decoded = JSON.parse(response);
  } catch {
    throw new AgentFailedError(
      "Codex structured completion returned malformed JSON",
      "codex",
    );
  }
  try {
    const parsed = z.fromJSONSchema(outputSchema as never).safeParse(decoded);
    if (!parsed.success) {
      throw new AgentFailedError(
        "Codex structured completion did not match its output schema",
        "codex",
      );
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof AgentFailedError) throw error;
    throw new AgentFailedError(
      "Codex structured completion output schema could not be validated",
      "codex",
    );
  }
}

export class CodexSdkProvider
  implements AgentProvider, StructuredCompletionProvider
{
  readonly #createCodex: (options: CodexOptions) => CodexClient;
  readonly #environment: () => Readonly<Record<string, string | undefined>>;
  readonly #credentials?: CredentialStore;
  readonly #createHandleId: () => string;
  readonly #solariGuardPath: string;
  readonly #activeExecutions = new Map<string, ActiveExecution>();

  constructor(options: CodexSdkProviderOptions = {}) {
    this.#createCodex =
      options.createCodex ?? ((codexOptions) => new Codex(codexOptions));
    this.#environment = options.environment ?? (() => safeChildEnvironment());
    this.#credentials = options.credentials;
    this.#createHandleId = options.createHandleId ?? randomUUID;
    this.#solariGuardPath = options.solariGuardPath
      ?? resolve("src/core/agents/solari-mcp-guard.mjs");
  }

  describe(): AgentProviderDescription {
    return {
      id: "codex",
      name: "Codex SDK",
      adapterVersion: "1.0.0",
      capabilities: {
        planning: true,
        streaming: true,
        tools: true,
        structuredCompletion: true,
      },
      optionsSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    };
  }

  async preflight(
    input: ProviderPreflightInput,
  ): Promise<ProviderPreflightResult> {
    requiredModel(input.agent);
    reasoningEffort(input.agent);
    if (input.agent.provider.toLowerCase() !== "codex") {
      throw new ProviderIncompatibleError(
        "codex",
        `Codex provider cannot run agent ${input.agent.id}`,
      );
    }
    if (
      input.agent.credential !== undefined &&
      (this.#credentials === undefined ||
        !(await this.#credentials.has(input.agent.credential)))
    ) {
      throw new CredentialMissingError(input.agent.credential, "codex");
    }
    return { ok: true };
  }

  async plan(input: ProviderPlanInput, signal: AbortSignal): Promise<RunPlan> {
    signal.throwIfAborted();
    const codex = this.#createCodex({
      env: planningEnvironment(this.#environment()),
    });
    const thread = codex.startThread(
      threadOptions(input.agent, input.snapshot.root, "read-only"),
    );
    const result = await thread.run(buildCodexPlanningPrompt(input.task), {
      outputSchema: runPlanOutputJsonSchema(),
      signal,
    });
    return parseCodexRunPlan(result.finalResponse, input.task);
  }

  async execute(
    input: ProviderExecutionInput,
    sink: AgentEventSink,
    signal: AbortSignal,
  ): Promise<ProviderExecution> {
    signal.throwIfAborted();
    const plan = validateCodexRunPlan(input.plan, input.task);
    const handle: ProviderRunHandle = { id: this.#createHandleId() };
    if (this.#activeExecutions.has(handle.id)) {
      throw new AgentFailedError("Codex execution handle collision", "codex");
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const environment = executionEnvironment(this.#environment());
    const codex = this.#createCodex({
      env: environment,
      config: {
        mcp_servers: {
          solari: solariMcpServerDefinition(
            plan.primitives,
            this.#solariGuardPath,
          ),
        },
      },
    });
    const thread = codex.startThread(
      threadOptions(input.agent, input.workspace.root, "workspace-write"),
    );
    const result = this.#runExecution(
      thread,
      input,
      sink,
      controller.signal,
      environment.SOLARI_API_KEY === undefined
        ? []
        : [environment.SOLARI_API_KEY],
    );
    this.#activeExecutions.set(handle.id, { controller, result });
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      this.#activeExecutions.delete(handle.id);
    };
    void result.then(cleanup, cleanup);
    return { handle, result };
  }

  async cancel(handle: ProviderRunHandle): Promise<void> {
    const active = this.#activeExecutions.get(handle.id);
    if (active === undefined) return;
    active.controller.abort(new Error("Codex execution cancelled"));
    try {
      await active.result;
    } catch {
      // Cancellation waits for the SDK-managed child to stop, not for success.
    }
  }

  async completeStructured(
    input: StructuredCompletionInput,
    signal: AbortSignal,
  ): Promise<StructuredCompletionResult> {
    signal.throwIfAborted();
    const codex = this.#createCodex({
      env: planningEnvironment(this.#environment()),
    });
    const thread = codex.startThread(
      threadOptions(input.agent, input.workingDirectory, "read-only"),
    );
    const result = await thread.run(structuredPrompt(input), {
      outputSchema: input.outputSchema,
      signal,
    });
    return {
      resolvedModel: requiredModel(input.agent),
      text: result.finalResponse,
      usage: codexUsage(result.usage),
      nativeResponse: validateStructuredResponse(
        result.finalResponse,
        input.outputSchema,
      ),
    };
  }

  async #runExecution(
    thread: CodexThreadClient,
    input: ProviderExecutionInput,
    sink: AgentEventSink,
    signal: AbortSignal,
    exactValues: readonly string[],
  ): Promise<ProviderExecutionResult> {
    const transcript: string[] = [];
    let finalResponse: string | undefined;
    let usage;
    let failure: string | undefined;
    try {
      const streamed = await thread.runStreamed(input.task.prompt, { signal });
      for await (const event of streamed.events) {
        transcript.push(
          redact(JSON.stringify(event), {
            localRoots: [input.workspace.root],
            exactValues,
          }),
        );
        for (const normalized of normalizeCodexEvent(event)) {
          await sink.emit(normalized.kind, normalized.payload);
        }
        finalResponse = codexEventFinalResponse(event) ?? finalResponse;
        usage = codexEventUsage(event) ?? usage;
        failure = codexEventFailure(event) ?? failure;
      }
      if (failure !== undefined) {
        throw new AgentFailedError("Codex execution failed", "codex");
      }
      return {
        resolvedModel: requiredModel(input.agent),
        usage: codexUsage(usage),
        finalResponse,
        nativeTranscript: transcript.join("\n"),
      };
    } catch (error) {
      if (error instanceof AgentFailedError) throw error;
      throw new AgentFailedError("Codex execution failed", "codex");
    }
  }
}
