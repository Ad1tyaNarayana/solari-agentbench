import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  CodexOptions,
  ThreadEvent,
  ThreadOptions,
  TurnOptions,
} from "@openai/codex-sdk";
import { describe, expect, it, vi } from "vitest";
import type { AgentDefinition, BenchmarkTaskDefinition } from "@/core/benchmarks/types";
import type { RunPlan } from "@/core/domain/plan";
import { createAgentEventSink, type AgentEvent } from "@/core/providers/events";
import {
  CodexSdkProvider,
  type CodexClient,
  type CodexThreadClient,
} from "@/core/providers/codex-sdk";
import type {
  AgentEventSink,
  ProviderExecutionInput,
  ProviderPlanInput,
} from "@/core/providers/types";

const agent: AgentDefinition = {
  id: "codex-local",
  name: "Codex Local",
  provider: "codex",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  harness: { id: "codex-sdk", version: "local" },
  options: {},
};

const task: BenchmarkTaskDefinition = {
  id: "sample",
  name: "Sample",
  promptPath: "tasks/sample/prompt.md",
  prompt: "Build exactly the snapshotted sample.",
  fixtures: [],
  allowedPrimitives: ["sandbox", "browser"],
  planningRequired: true,
  resourceLimits: {
    browserSessions: 1,
    sandboxes: 1,
    desktops: 0,
    totalMinutes: 5,
  },
  submission: {
    directory: "submission",
    required: ["results.json"],
  },
  evaluators: [],
};

const snapshot = {
  digest: "snapshot-digest",
  root: "C:\\snapshots\\snapshot-digest",
  files: [],
};

const validPlan: RunPlan = {
  primitives: ["sandbox"],
  reason: { sandbox: "build and test in isolation" },
  verificationStrategy: "run the task checks",
};

type FakeSdk = {
  createOptions: CodexOptions[];
  threadOptions: ThreadOptions[];
  runs: Array<{ input: unknown; options: TurnOptions | undefined }>;
  executions: Array<{ input: unknown; options: TurnOptions | undefined }>;
  createCodex(options: CodexOptions): CodexClient;
};

function eventFixture(): ThreadEvent[] {
  return readFileSync(resolve("tests/fixtures/codex-sdk/events.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as ThreadEvent);
}

function fakeSdk(input: {
  runResponse?: {
    finalResponse: string;
    items?: [];
    usage?: {
      input_tokens: number;
      cached_input_tokens: number;
      cache_write_input_tokens: number;
      output_tokens: number;
      reasoning_output_tokens: number;
    } | null;
  };
  events?: ThreadEvent[];
} = {}): FakeSdk {
  const createOptions: CodexOptions[] = [];
  const threadOptions: ThreadOptions[] = [];
  const runs: FakeSdk["runs"] = [];
  const executions: FakeSdk["executions"] = [];
  const thread: CodexThreadClient = {
    async run(runInput, options) {
      runs.push({ input: runInput, options });
      return {
        finalResponse: input.runResponse?.finalResponse ?? JSON.stringify(validPlan),
        items: input.runResponse?.items ?? [],
        usage: input.runResponse?.usage ?? null,
      };
    },
    async runStreamed(runInput, options) {
      executions.push({ input: runInput, options });
      async function* stream(): AsyncGenerator<ThreadEvent> {
        for (const event of input.events ?? eventFixture()) yield event;
      }
      return { events: stream() };
    },
  };

  return {
    createOptions,
    threadOptions,
    runs,
    executions,
    createCodex(options) {
      createOptions.push(options);
      return {
        startThread(options) {
          threadOptions.push(options ?? {});
          return thread;
        },
      };
    },
  };
}

function planInput(): ProviderPlanInput {
  return {
    agent,
    task,
    snapshot,
    remainingMs: () => 30_000,
  };
}

function executionInput(): ProviderExecutionInput {
  return {
    agent,
    task,
    snapshot,
    plan: validPlan,
    workspace: {
      root: "C:\\workspaces\\run-1",
      dispose: async () => undefined,
    },
    tools: {
      listDefinitions: () => [],
      invoke: async () => undefined,
    },
    remainingMs: () => 30_000,
  };
}

function recordingSink(): { sink: AgentEventSink; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return {
    events,
    sink: createAgentEventSink({
      provider: "codex",
      redact: (value) => value,
      publish: (event) => events.push(event),
      now: () => "2026-09-04T00:00:00.000Z",
    }),
  };
}

describe("CodexSdkProvider planning", () => {
  it("uses structured output in the read-only snapshot without Solari MCP", async () => {
    const sdk = fakeSdk();
    const provider = new CodexSdkProvider({
      createCodex: sdk.createCodex,
      environment: () => ({ PATH: "test-path" }),
    });

    const plan = await provider.plan(planInput(), new AbortController().signal);

    expect(plan).toEqual(validPlan);
    expect(sdk.createOptions).toEqual([{ env: { PATH: "test-path" } }]);
    expect(sdk.threadOptions).toEqual([
      {
        model: "gpt-5.6-sol",
        modelReasoningEffort: "high",
        sandboxMode: "read-only",
        workingDirectory: snapshot.root,
        skipGitRepoCheck: true,
        approvalPolicy: "never",
        networkAccessEnabled: false,
        webSearchMode: "disabled",
      },
    ]);
    expect(sdk.runs[0].input).toContain(task.prompt);
    expect(sdk.runs[0].input).toContain("Allowed primitives: sandbox, browser");
    expect(sdk.runs[0].options?.outputSchema).toEqual(
      expect.objectContaining({
        type: "object",
        required: ["primitives", "reason", "verificationStrategy"],
        additionalProperties: false,
      }),
    );
    expect(sdk.executions).toHaveLength(0);
  });

  it("raises plan_invalid locally before any execution thread starts", async () => {
    const sdk = fakeSdk({
      runResponse: {
        finalResponse: JSON.stringify({ ...validPlan, primitives: ["desktop"] }),
      },
    });
    const provider = new CodexSdkProvider({
      createCodex: sdk.createCodex,
      environment: () => ({ PATH: "test-path" }),
    });

    await expect(
      provider.plan(planInput(), new AbortController().signal),
    ).rejects.toEqual(expect.objectContaining({ code: "plan_invalid" }));
    expect(sdk.executions).toHaveLength(0);
  });

  it("filters the injected environment and excludes Solari credentials from planning", async () => {
    const sdk = fakeSdk();
    const provider = new CodexSdkProvider({
      createCodex: sdk.createCodex,
      environment: () => ({
        PATH: "test-path",
        SOLARI_API_KEY: "run-scoped-key",
        UNRELATED_DEPLOY_SECRET: "must-not-cross-the-boundary",
      }),
    });

    await provider.plan(planInput(), new AbortController().signal);

    expect(sdk.createOptions[0].env).toEqual({ PATH: "test-path" });

    const { sink } = recordingSink();
    const execution = await provider.execute(
      executionInput(),
      sink,
      new AbortController().signal,
    );
    await execution.result;
    expect(sdk.createOptions[1].env).toEqual({
      PATH: "test-path",
      SOLARI_API_KEY: "run-scoped-key",
    });
  });

  it("performs structured completion in the explicit read-only directory and validates it locally", async () => {
    const sdk = fakeSdk({
      runResponse: {
        finalResponse: JSON.stringify({ verdict: "pass" }),
        usage: {
          input_tokens: 14,
          cached_input_tokens: 2,
          cache_write_input_tokens: 0,
          output_tokens: 3,
          reasoning_output_tokens: 1,
        },
      },
    });
    const provider = new CodexSdkProvider({
      createCodex: sdk.createCodex,
      environment: () => ({ PATH: "test-path" }),
    });
    const outputSchema = {
      type: "object",
      properties: { verdict: { type: "string", enum: ["pass", "fail"] } },
      required: ["verdict"],
      additionalProperties: false,
    };

    const result = await provider.completeStructured(
      {
        agent,
        system: "Judge only against the rubric.",
        prompt: "Evaluate the submission.",
        outputSchema,
        workingDirectory: "C:\\judge\\workspace",
      },
      new AbortController().signal,
    );

    expect(sdk.createOptions).toEqual([{ env: { PATH: "test-path" } }]);
    expect(sdk.threadOptions[0]).toEqual(
      expect.objectContaining({
        sandboxMode: "read-only",
        workingDirectory: "C:\\judge\\workspace",
        networkAccessEnabled: false,
      }),
    );
    expect(sdk.runs[0]).toEqual({
      input: "Judge only against the rubric.\n\nEvaluate the submission.",
      options: expect.objectContaining({ outputSchema }),
    });
    expect(result).toEqual({
      resolvedModel: "gpt-5.6-sol",
      text: JSON.stringify({ verdict: "pass" }),
      usage: { inputTokens: 14, outputTokens: 3 },
      nativeResponse: { verdict: "pass" },
    });

    const invalidSdk = fakeSdk({
      runResponse: { finalResponse: JSON.stringify({ verdict: "maybe" }) },
    });
    const invalidProvider = new CodexSdkProvider({
      createCodex: invalidSdk.createCodex,
      environment: () => ({ PATH: "test-path" }),
    });
    await expect(
      invalidProvider.completeStructured(
        {
          agent,
          system: "Judge.",
          prompt: "Evaluate.",
          outputSchema,
          workingDirectory: "C:\\judge\\workspace",
        },
        new AbortController().signal,
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "agent_failed" }));
  });
});

describe("CodexSdkProvider execution", () => {
  it("rejects a structurally invalid direct execution plan before SDK or resource activity", async () => {
    const sdk = fakeSdk();
    const provider = new CodexSdkProvider({
      createCodex: sdk.createCodex,
      environment: () => ({ PATH: "test-path" }),
    });
    const { sink, events } = recordingSink();
    const input = executionInput();
    const invoke = vi.fn(async () => undefined);
    input.tools = {
      listDefinitions: () => [],
      invoke,
    };
    input.plan = {
      primitives: ["sandbox", "sandbox"],
      reason: { sandbox: "duplicate structural input" },
      verificationStrategy: "run checks",
    };

    await expect(
      provider.execute(input, sink, new AbortController().signal),
    ).rejects.toEqual(expect.objectContaining({ code: "plan_invalid" }));
    expect(sdk.createOptions).toHaveLength(0);
    expect(sdk.threadOptions).toHaveLength(0);
    expect(sdk.executions).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects a task-disallowed direct execution primitive before SDK or resource activity", async () => {
    const sdk = fakeSdk();
    const provider = new CodexSdkProvider({
      createCodex: sdk.createCodex,
      environment: () => ({ PATH: "test-path" }),
    });
    const { sink, events } = recordingSink();
    const input = executionInput();
    const invoke = vi.fn(async () => undefined);
    input.tools = {
      listDefinitions: () => [],
      invoke,
    };
    input.plan = {
      primitives: ["desktop"],
      reason: { desktop: "use a forbidden desktop" },
      verificationStrategy: "capture a screenshot",
    };

    await expect(
      provider.execute(input, sink, new AbortController().signal),
    ).rejects.toEqual(expect.objectContaining({ code: "plan_invalid" }));
    expect(sdk.createOptions).toHaveLength(0);
    expect(sdk.threadOptions).toHaveLength(0);
    expect(sdk.executions).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("streams the exact snapshotted prompt through the approved Solari config and normalizes events in order", async () => {
    const sdk = fakeSdk({ events: eventFixture() });
    const provider = new CodexSdkProvider({
      createCodex: sdk.createCodex,
      environment: () => ({ PATH: "test-path", SOLARI_API_KEY: "scoped-key" }),
      createHandleId: () => "codex-run-1",
    });
    const { sink, events } = recordingSink();

    const execution = await provider.execute(
      executionInput(),
      sink,
      new AbortController().signal,
    );
    const result = await execution.result;

    expect(execution.handle).toEqual({ id: "codex-run-1" });
    expect(sdk.executions[0].input).toBe(task.prompt);
    expect(sdk.threadOptions).toEqual([
      expect.objectContaining({
        model: "gpt-5.6-sol",
        sandboxMode: "workspace-write",
        workingDirectory: "C:\\workspaces\\run-1",
        approvalPolicy: "never",
      }),
    ]);
    expect(sdk.createOptions[0].env).toEqual({
      PATH: "test-path",
      SOLARI_API_KEY: "scoped-key",
    });
    expect(sdk.createOptions[0].config).toEqual({
      mcp_servers: {
        solari: expect.objectContaining({
          enabled_tools: [
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
        }),
      },
    });
    expect(events.map((event) => event.kind)).toEqual([
      "reasoning-summary",
      "tool-request",
      "tool-result",
      "tool-request",
      "tool-result",
      "artifact",
      "warning",
      "message",
      "usage",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(events[1].payload).toEqual({
      id: "command-1",
      tool: "command_execution",
      arguments: { command: "npm test" },
    });
    expect(events[4].payload).toEqual(
      expect.objectContaining({
        id: "tool-1",
        tool: "solari.solari_sandbox_create",
        status: "completed",
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        resolvedModel: "gpt-5.6-sol",
        finalResponse: "Submission complete",
        usage: { inputTokens: 120, outputTokens: 30 },
      }),
    );
    expect(result.nativeTranscript).toContain('"type":"turn.completed"');
  });

  it("redacts the run-scoped Solari credential from the native transcript", async () => {
    const sdk = fakeSdk({
      events: [
        {
          type: "item.completed",
          item: {
            id: "message-1",
            type: "agent_message",
            text: "credential run-scoped-key must not persist",
          },
        },
        {
          type: "turn.completed",
          usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 1,
            reasoning_output_tokens: 0,
          },
        },
      ],
    });
    const provider = new CodexSdkProvider({
      createCodex: sdk.createCodex,
      environment: () => ({ PATH: "test-path", SOLARI_API_KEY: "run-scoped-key" }),
    });
    const { sink } = recordingSink();
    const execution = await provider.execute(
      executionInput(),
      sink,
      new AbortController().signal,
    );

    const result = await execution.result;

    expect(result.nativeTranscript).not.toContain("run-scoped-key");
    expect(result.nativeTranscript).toContain("[REDACTED]");
  });

  it("propagates provider cancellation through the SDK turn signal", async () => {
    let turnSignal: AbortSignal | undefined;
    let executionStopped = false;
    let observeAbort!: () => void;
    const aborted = new Promise<void>((resolveAbort) => {
      observeAbort = resolveAbort;
    });
    const thread: CodexThreadClient = {
      async run() {
        throw new Error("run must not be called for execution");
      },
      async runStreamed(_input, options) {
        turnSignal = options?.signal;
        async function* events(): AsyncGenerator<ThreadEvent> {
          await new Promise<never>((_resolve, reject) => {
            turnSignal?.addEventListener(
              "abort",
              () => {
                observeAbort();
                setTimeout(() => {
                  executionStopped = true;
                  reject(turnSignal?.reason);
                }, 0);
              },
              { once: true },
            );
          });
        }
        return { events: events() };
      },
    };
    const provider = new CodexSdkProvider({
      createCodex: () => ({ startThread: () => thread }),
      environment: () => ({ PATH: "test-path" }),
      createHandleId: () => "cancel-me",
    });
    const { sink } = recordingSink();
    const execution = await provider.execute(
      executionInput(),
      sink,
      new AbortController().signal,
    );

    await provider.cancel(execution.handle);
    await aborted;

    expect(turnSignal?.aborted).toBe(true);
    expect(executionStopped).toBe(true);
    await expect(execution.result).rejects.toEqual(
      expect.objectContaining({ code: "agent_failed" }),
    );
  });

  it("emits a normalized error and rejects when the SDK turn fails", async () => {
    const sdk = fakeSdk({
      events: [
        { type: "turn.started" },
        { type: "turn.failed", error: { message: "native failure" } },
      ],
    });
    const provider = new CodexSdkProvider({
      createCodex: sdk.createCodex,
      environment: () => ({ PATH: "test-path" }),
    });
    const { sink, events } = recordingSink();
    const execution = await provider.execute(
      executionInput(),
      sink,
      new AbortController().signal,
    );

    await expect(execution.result).rejects.toEqual(
      expect.objectContaining({ code: "agent_failed" }),
    );
    expect(events.map((event) => event.kind)).toEqual(["error"]);
    expect(events[0].payload).toEqual({ message: "native failure" });
  });
});

describe("CodexSdkProvider metadata and preflight", () => {
  it("describes the codex provider without starting a billable thread", async () => {
    const sdk = fakeSdk();
    const credentials = {
      listMetadata: vi.fn(async () => []),
      has: vi.fn(async () => true),
      withCredential: vi.fn(),
    };
    const provider = new CodexSdkProvider({
      createCodex: sdk.createCodex,
      environment: () => ({ PATH: "test-path" }),
      credentials,
    });

    expect(provider.describe()).toEqual(
      expect.objectContaining({
        id: "codex",
        capabilities: {
          planning: true,
          streaming: true,
          tools: true,
          structuredCompletion: true,
        },
      }),
    );
    await expect(
      provider.preflight({ agent, task, snapshot }),
    ).resolves.toEqual({ ok: true });
    expect(sdk.createOptions).toHaveLength(0);
  });
});
