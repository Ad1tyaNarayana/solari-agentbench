export type ProviderErrorCode =
  | "provider_unavailable"
  | "provider_incompatible"
  | "credential_missing"
  | "preflight_failed"
  | "agent_timeout"
  | "agent_failed";

export type ProviderErrorContext = {
  providerId?: string;
  credentialRef?: string;
  cause?: unknown;
};

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly providerId?: string;
  readonly credentialRef?: string;

  constructor(
    code: ProviderErrorCode,
    message: string,
    context: ProviderErrorContext = {},
  ) {
    super(message, context.cause === undefined ? undefined : { cause: context.cause });
    this.name = "ProviderError";
    this.code = code;
    this.providerId = context.providerId;
    this.credentialRef = context.credentialRef;
  }
}

export class ProviderUnavailableError extends ProviderError {
  constructor(providerId: string, cause?: unknown) {
    super(
      "provider_unavailable",
      `Provider is unavailable: ${providerId}`,
      { providerId, cause },
    );
    this.name = "ProviderUnavailableError";
  }
}

export class ProviderIncompatibleError extends ProviderError {
  constructor(providerId: string, message?: string, cause?: unknown) {
    super(
      "provider_incompatible",
      message ?? `Provider is incompatible: ${providerId}`,
      { providerId, cause },
    );
    this.name = "ProviderIncompatibleError";
  }
}

export class CredentialMissingError extends ProviderError {
  constructor(credentialRef: string, providerId?: string) {
    super(
      "credential_missing",
      `Credential is not configured: ${credentialRef}`,
      { providerId, credentialRef },
    );
    this.name = "CredentialMissingError";
  }
}

export class PreflightFailedError extends ProviderError {
  constructor(message: string, providerId?: string, cause?: unknown) {
    super("preflight_failed", message, { providerId, cause });
    this.name = "PreflightFailedError";
  }
}

export class AgentTimeoutError extends ProviderError {
  constructor(message: string, providerId?: string, cause?: unknown) {
    super("agent_timeout", message, { providerId, cause });
    this.name = "AgentTimeoutError";
  }
}

export class AgentFailedError extends ProviderError {
  constructor(message: string, providerId?: string, cause?: unknown) {
    super("agent_failed", message, { providerId, cause });
    this.name = "AgentFailedError";
  }
}

export class ProviderProtocolError extends AgentFailedError {
  constructor(message: string, providerId?: string, cause?: unknown) {
    super(message, providerId, cause);
    this.name = "ProviderProtocolError";
  }
}
