import {
  redactCredentialError,
  registerCredentialValue,
  snapshotCredentialRedaction,
} from "./redaction";

export type CredentialSource = "environment" | "local-file";

export type CredentialMetadata = {
  ref: string;
  label?: string;
  source: CredentialSource;
  configured: boolean;
};

export interface CredentialStore {
  listMetadata(): Promise<CredentialMetadata[]>;
  has(ref: string): Promise<boolean>;
  withCredential<T>(
    ref: string,
    callback: (secret: SecretValue) => Promise<T>,
  ): Promise<T>;
}

export const credentialReferencePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function isCredentialReference(value: string): boolean {
  return credentialReferencePattern.test(value);
}

export class SecretValue {
  readonly #value: string;
  #active = false;

  private constructor(value: string) {
    this.#value = value;
  }

  static async withValue<T>(
    value: string,
    callback: (secret: SecretValue) => Promise<T>,
  ): Promise<T> {
    const secret = new SecretValue(value);
    const release = registerCredentialValue(value);
    secret.#active = true;
    try {
      return await callback(secret);
    } catch (error) {
      throw redactCredentialError(error, snapshotCredentialRedaction());
    } finally {
      secret.#active = false;
      release();
    }
  }

  reveal(): string {
    if (!this.#active) {
      throw new Error("SecretValue cannot be revealed outside its active scope");
    }
    return this.#value;
  }

  toJSON(): never {
    throw new Error("SecretValue cannot be serialized");
  }

  toString(): string {
    return "[REDACTED]";
  }
}
