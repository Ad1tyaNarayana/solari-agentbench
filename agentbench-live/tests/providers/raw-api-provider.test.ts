import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition, BenchmarkTaskDefinition } from "@/core/benchmarks/types";
import { SecretValue, type CredentialStore } from "@/core/credentials/types";
import { createAgentEventSink } from "@/core/providers/events";
import { RawApiProvider } from "@/core/providers/raw-api-provider";
import type { ModelCompletionInput, ModelTransport } from "@/core/providers/transports/types";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const task: BenchmarkTaskDefinition = {
  id: "sample", name: "Sample", promptPath: "prompt.md", prompt: "Build it.", fixtures: [],
  allowedPrimitives: ["sandbox"], planningRequired: true,
  resourceLimits: { browserSessions: 0, sandboxes: 1, desktops: 0, totalMinutes: 5 },
  submission: { directory: "submission", required: ["results.json"] },
  evaluationPolicy: { maxModelJudgeWeight: 30, allowModelJudgeMajority: false }, evaluators: [],
};
const snapshot = { digest: "digest", root: process.cwd(), files: [] };
const agent: AgentDefinition = {
  id: "anthropic-test", name: "Anthropic", provider: "anthropic", model: "claude-test",
  credential: "anthropic-primary", harness: { id: "raw", version: "1" }, options: {},
};

function credentials(): CredentialStore {
  return {
    listMetadata: async () => [{ ref: "anthropic-primary", source: "environment", configured: true }],
    has: async (ref) => ref === "anthropic-primary",
    withCredential: async (ref, use) => {
      if (ref !== "anthropic-primary") throw new Error("missing");
      return SecretValue.withValue("provider-secret", use);
    },
  };
}

function sink() {
  return createAgentEventSink({ provider: "anthropic", redact: (value) => value,
    publish: () => undefined, now: () => "2026-09-04T00:00:00.000Z" });
}

describe("RawApiProvider", () => {
  it("preflights credentials and plans through a credential-scoped transport", async () => {
    const complete = vi.fn(async () => ({
      text: JSON.stringify({
        primitives: ["sandbox"], reason: { sandbox: "run isolated checks" },
        verificationStrategy: "inspect generated results",
      }),
      toolCalls: [], finishReason: "stop",
    }));
    const createTransport = vi.fn((apiKey: string): ModelTransport => {
      expect(apiKey).toBe("provider-secret");
      return { complete };
    });
    const provider = new RawApiProvider({ id: "anthropic", credentials: credentials(), createTransport });

    await expect(provider.preflight({ agent, task, snapshot })).resolves.toEqual({ ok: true });
    const plan = await provider.plan(
      { agent, task, snapshot, remainingMs: () => 10_000 },
      new AbortController().signal,
    );

    expect(createTransport).toHaveBeenCalledWith("provider-secret", agent);
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ tools: [], model: "claude-test" }));
    expect(plan.primitives).toEqual(["sandbox"]);
  });

  it("executes the shared loop and validates structured completions locally", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentbench-raw-provider-"));
    roots.push(root);
    await mkdir(join(root, "submission"));
    const replies = [
      { text: "finished", toolCalls: [], usage: { inputTokens: 2, outputTokens: 1 }, finishReason: "stop" },
      { text: '{"verdict":"pass"}', toolCalls: [], finishReason: "stop" },
    ];
    const transport: ModelTransport = { complete: vi.fn(async () => replies.shift()!) };
    const provider = new RawApiProvider({
      id: "anthropic", credentials: credentials(), createTransport: () => transport,
      createHandleId: () => "raw-1",
    });
    const execution = await provider.execute({
      agent, task, snapshot,
      plan: { primitives: ["sandbox"], reason: { sandbox: "run isolated checks" }, verificationStrategy: "inspect results" },
      workspace: { root, dispose: async () => undefined },
      tools: { listDefinitions: () => [], invoke: async () => undefined },
      remainingMs: () => 10_000,
    }, sink(), new AbortController().signal);

    await expect(execution.result).resolves.toEqual(expect.objectContaining({
      resolvedModel: "claude-test", finalResponse: "finished",
      usage: { inputTokens: 2, outputTokens: 1 },
    }));
    await expect(provider.completeStructured({
      agent, system: "judge", prompt: "evaluate",
      outputSchema: {
        type: "object", properties: { verdict: { type: "string", enum: ["pass", "fail"] } },
        required: ["verdict"], additionalProperties: false,
      },
      workingDirectory: root,
    }, new AbortController().signal)).resolves.toEqual(expect.objectContaining({
      resolvedModel: "claude-test", text: '{"verdict":"pass"}', nativeResponse: { verdict: "pass" },
    }));
  });

  it("cancels an active model request through its abort signal", async () => {
    let observed: AbortSignal | undefined;
    const transport: ModelTransport = {
      complete: async (input: ModelCompletionInput) => {
        observed = input.signal;
        return await new Promise((_resolve, reject) => input.signal.addEventListener(
          "abort", () => reject(input.signal.reason), { once: true },
        ));
      },
    };
    const provider = new RawApiProvider({
      id: "anthropic", credentials: credentials(), createTransport: () => transport,
      createHandleId: () => "cancel-raw",
    });
    const execution = await provider.execute({
      agent, task, snapshot,
      plan: { primitives: ["sandbox"], reason: { sandbox: "run isolated checks" }, verificationStrategy: "inspect results" },
      workspace: { root: process.cwd(), dispose: async () => undefined },
      tools: { listDefinitions: () => [], invoke: async () => undefined },
      remainingMs: () => 10_000,
    }, sink(), new AbortController().signal);

    await provider.cancel(execution.handle);

    expect(observed?.aborted).toBe(true);
    await expect(execution.result).rejects.toEqual(expect.objectContaining({ code: "agent_failed" }));
  });
});
