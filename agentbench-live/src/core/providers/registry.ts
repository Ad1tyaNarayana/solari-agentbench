import {
  ProviderIncompatibleError,
  ProviderUnavailableError,
} from "./errors";
import type {
  AgentProvider,
  AgentProviderDescription,
  StructuredCompletionProvider,
} from "./types";

type RegisteredProvider = {
  provider: AgentProvider;
  description: AgentProviderDescription;
};

function normalizeProviderId(id: string): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return undefined;
  return id.toLowerCase();
}

function copyDescription(
  description: AgentProviderDescription,
): AgentProviderDescription {
  return {
    ...description,
    capabilities: { ...description.capabilities },
    optionsSchema: { ...description.optionsSchema },
  };
}

export class AgentProviderRegistry {
  private readonly providers = new Map<string, RegisteredProvider>();

  register(id: string, provider: AgentProvider): void {
    const normalizedId = normalizeProviderId(id);
    if (!normalizedId) {
      throw new ProviderIncompatibleError(
        id,
        "Provider IDs must contain only ASCII letters, digits, dots, underscores, or hyphens",
      );
    }
    if (this.providers.has(normalizedId)) {
      throw new ProviderIncompatibleError(
        normalizedId,
        `Provider is already registered: ${normalizedId}`,
      );
    }

    const description = provider.describe();
    const describedId = normalizeProviderId(description.id);
    if (describedId !== normalizedId) {
      throw new ProviderIncompatibleError(
        normalizedId,
        `Provider description ID ${description.id} does not match registration ID ${normalizedId}`,
      );
    }

    this.providers.set(normalizedId, {
      provider,
      description: copyDescription({ ...description, id: normalizedId }),
    });
  }

  get(id: string): AgentProvider {
    const normalizedId = normalizeProviderId(id);
    const registration = normalizedId
      ? this.providers.get(normalizedId)
      : undefined;
    if (!registration) {
      throw new ProviderUnavailableError(normalizedId ?? id);
    }
    return registration.provider;
  }

  getStructuredCompletion(
    id: string,
  ): AgentProvider & StructuredCompletionProvider {
    const provider = this.get(id);
    const normalizedId = normalizeProviderId(id) ?? id;
    const registration = this.providers.get(normalizedId);
    if (
      !registration?.description.capabilities.structuredCompletion ||
      !("completeStructured" in provider) ||
      typeof provider.completeStructured !== "function"
    ) {
      throw new ProviderIncompatibleError(
        normalizedId,
        `Provider does not support structured completion: ${normalizedId}`,
      );
    }
    return provider as AgentProvider & StructuredCompletionProvider;
  }

  describeAll(): AgentProviderDescription[] {
    return [...this.providers.values()].map(({ description }) =>
      copyDescription(description),
    );
  }
}
