import { CompositeCredentialStore } from "@/core/credentials/composite-store";
import { EnvironmentCredentialStore } from "@/core/credentials/environment-store";
import { LocalFileCredentialStore } from "@/core/credentials/local-file-store";
import type { CredentialStore } from "@/core/credentials/types";
import { CodexSdkProvider } from "./codex-sdk";
import { ExecutableJsonlProvider } from "./executable-jsonl";
import { createAnthropicProvider, createOpenAICompatibleProvider } from "./raw-api-provider";
import { AgentProviderRegistry } from "./registry";

export function createDefaultCredentialStore(): CredentialStore {
  return new CompositeCredentialStore([
    new EnvironmentCredentialStore(),
    new LocalFileCredentialStore(),
  ]);
}

export function createBuiltinProviderRegistry(
  credentials: CredentialStore,
): AgentProviderRegistry {
  const registry = new AgentProviderRegistry();
  registry.register("codex", new CodexSdkProvider({ credentials }));
  registry.register("executable-jsonl", new ExecutableJsonlProvider());
  registry.register("anthropic", createAnthropicProvider(credentials));
  registry.register(
    "openai-compatible",
    createOpenAICompatibleProvider(credentials),
  );
  return registry;
}
