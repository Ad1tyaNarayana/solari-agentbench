import { describe, expect, it, vi } from "vitest";
import {
  AgentFailedError,
  AgentTimeoutError,
  CredentialMissingError,
  PreflightFailedError,
  ProviderIncompatibleError,
  ProviderUnavailableError,
} from "@/core/providers/errors";
import { AgentProviderRegistry } from "@/core/providers/registry";
import type {
  AgentProvider,
  AgentProviderDescription,
  StructuredCompletionProvider,
} from "@/core/providers/types";

function createProvider(
  description: Partial<AgentProviderDescription> = {},
): AgentProvider {
  const capabilities = {
    planning: true,
    streaming: true,
    tools: true,
    structuredCompletion: false,
    ...description.capabilities,
  };

  return {
    describe: () => ({
      id: "fake",
      name: "Fake provider",
      adapterVersion: "1.0.0",
      optionsSchema: {},
      ...description,
      capabilities,
    }),
    preflight: async () => ({ ok: true }),
    plan: async () => ({
      primitives: ["sandbox"],
      reason: { sandbox: "build the requested artifact" },
      verificationStrategy: "run the benchmark checks",
    }),
    execute: async () => ({
      handle: { id: "fake-run" },
      result: Promise.resolve({ finalResponse: "done" }),
    }),
    cancel: async () => undefined,
  };
}

describe("AgentProviderRegistry", () => {
  it("normalizes ASCII provider IDs and rejects case-insensitive duplicates", () => {
    const registry = new AgentProviderRegistry();
    registry.register("FAKE", createProvider({ id: "fake" }));

    expect(() => registry.register("fake", createProvider())).toThrowError(
      expect.objectContaining({
        name: "ProviderIncompatibleError",
        code: "provider_incompatible",
        providerId: "fake",
      }),
    );
    expect(registry.get("FaKe").describe().id).toBe("fake");
  });

  it("rejects invalid non-ASCII provider IDs", () => {
    const registry = new AgentProviderRegistry();

    expect(() => registry.register("faké", createProvider())).toThrowError(
      expect.objectContaining({ code: "provider_incompatible" }),
    );
  });

  it("throws a typed error for an unknown provider without selecting a fallback", () => {
    const registry = new AgentProviderRegistry();
    const fallback = createProvider();
    registry.register("fake", fallback);

    expect(() => registry.get("missing")).toThrowError(
      expect.objectContaining({
        name: "ProviderUnavailableError",
        code: "provider_unavailable",
        providerId: "missing",
      }),
    );
  });

  it("reports normalized descriptions for capability lookup", () => {
    const registry = new AgentProviderRegistry();
    registry.register(
      "FAKE",
      createProvider({
        id: "FAKE",
        capabilities: {
          planning: false,
          streaming: true,
          tools: false,
          structuredCompletion: false,
        },
      }),
    );

    expect(registry.describeAll()).toEqual([
      {
        id: "fake",
        name: "Fake provider",
        adapterVersion: "1.0.0",
        capabilities: {
          planning: false,
          streaming: true,
          tools: false,
          structuredCompletion: false,
        },
        optionsSchema: {},
      },
    ]);
  });

  it("does not expose mutable nested provider schema state", () => {
    const registry = new AgentProviderRegistry();
    registry.register("fake", createProvider({ optionsSchema: { properties: { model: { type: "string" } } } }));
    const first = registry.describeAll()[0].optionsSchema as { properties: { model: { type: string } } };
    first.properties.model.type = "number";
    expect((registry.describeAll()[0].optionsSchema as typeof first).properties.model.type).toBe("string");
  });

  it("rejects a judge assignment to an incompatible provider", () => {
    const registry = new AgentProviderRegistry();
    registry.register("fake", createProvider());

    expect(() => registry.getStructuredCompletion("fake")).toThrowError(
      expect.objectContaining({
        name: "ProviderIncompatibleError",
        code: "provider_incompatible",
        providerId: "fake",
      }),
    );
  });

  it("returns a provider that truthfully implements structured completion", async () => {
    const completeStructured = vi.fn(async () => ({ text: "{}" }));
    const provider = Object.assign(
      createProvider({
        capabilities: {
          planning: true,
          streaming: true,
          tools: true,
          structuredCompletion: true,
        },
      }),
      { completeStructured },
    ) satisfies AgentProvider & StructuredCompletionProvider;
    const registry = new AgentProviderRegistry();
    registry.register("fake", provider);

    expect(registry.getStructuredCompletion("fake")).toBe(provider);
  });
});

describe("provider lifecycle contracts", () => {
  it("defines every required typed provider failure code", () => {
    expect([
      new ProviderUnavailableError("missing"),
      new ProviderIncompatibleError("wrong capability"),
      new CredentialMissingError("credential-ref"),
      new PreflightFailedError("preflight rejected"),
      new AgentTimeoutError("deadline exhausted"),
      new AgentFailedError("provider failed"),
    ]).toEqual([
      expect.objectContaining({ code: "provider_unavailable" }),
      expect.objectContaining({ code: "provider_incompatible" }),
      expect.objectContaining({ code: "credential_missing" }),
      expect.objectContaining({ code: "preflight_failed" }),
      expect.objectContaining({ code: "agent_timeout" }),
      expect.objectContaining({ code: "agent_failed" }),
    ]);
  });
});
