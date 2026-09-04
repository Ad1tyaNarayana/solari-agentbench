import {
  type CredentialMetadata,
  type CredentialStore,
  isCredentialReference,
  SecretValue,
} from "./types";

const environmentVariablePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type EnvironmentCredentialStoreOptions = {
  environment?: Readonly<Record<string, string | undefined>>;
};

function parseEnvironmentMap(raw: string | undefined): ReadonlyMap<string, string> {
  if (raw === undefined || raw === "") return new Map();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AGENTBENCH_CREDENTIAL_ENV_MAP must be a valid JSON object");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AGENTBENCH_CREDENTIAL_ENV_MAP must be a valid JSON object");
  }

  const result = new Map<string, string>();
  for (const [ref, variableName] of Object.entries(parsed)) {
    if (!isCredentialReference(ref)) {
      throw new Error(
        "AGENTBENCH_CREDENTIAL_ENV_MAP contains an invalid credential reference",
      );
    }
    if (
      typeof variableName !== "string" ||
      !environmentVariablePattern.test(variableName)
    ) {
      throw new Error(
        "AGENTBENCH_CREDENTIAL_ENV_MAP contains an invalid environment variable name",
      );
    }
    result.set(ref, variableName);
  }
  return result;
}

export class EnvironmentCredentialStore implements CredentialStore {
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #references: ReadonlyMap<string, string>;

  constructor(options: EnvironmentCredentialStoreOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#references = parseEnvironmentMap(
      this.#environment.AGENTBENCH_CREDENTIAL_ENV_MAP,
    );
  }

  async listMetadata(): Promise<CredentialMetadata[]> {
    return [...this.#references]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([ref, variableName]) => ({
        ref,
        source: "environment",
        configured: this.#read(variableName) !== undefined,
      }));
  }

  async has(ref: string): Promise<boolean> {
    const variableName = this.#references.get(ref);
    return variableName !== undefined && this.#read(variableName) !== undefined;
  }

  async withCredential<T>(
    ref: string,
    callback: (secret: SecretValue) => Promise<T>,
  ): Promise<T> {
    const variableName = this.#references.get(ref);
    const value = variableName === undefined ? undefined : this.#read(variableName);
    if (value === undefined) {
      throw new Error("Credential reference is not configured");
    }
    return SecretValue.withValue(value, callback);
  }

  #read(variableName: string): string | undefined {
    const value = this.#environment[variableName];
    return value === "" || value === undefined ? undefined : value;
  }
}
