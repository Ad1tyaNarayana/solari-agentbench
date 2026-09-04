import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type CredentialMetadata,
  type CredentialStore,
  isCredentialReference,
  SecretValue,
} from "./types";

type LocalCredential = {
  value: string;
  label?: string;
};

type LocalCredentialFile = {
  credentials: ReadonlyMap<string, LocalCredential>;
};

export type LocalFileCredentialStoreOptions = {
  cwd?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function isSecureCredentialFileMode(mode: number): boolean {
  return (mode & 0o400) !== 0 && (mode & 0o077) === 0;
}

function parseCredentialFile(raw: string): LocalCredentialFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Local credential file is not valid JSON");
  }

  if (
    !isRecord(parsed) ||
    !hasOnlyKeys(parsed, ["schemaVersion", "credentials"]) ||
    parsed.schemaVersion !== 1 ||
    !isRecord(parsed.credentials)
  ) {
    throw new Error("Local credential file does not match schema version 1");
  }

  const credentials = new Map<string, LocalCredential>();
  for (const [ref, entry] of Object.entries(parsed.credentials)) {
    if (
      !isCredentialReference(ref) ||
      !isRecord(entry) ||
      !hasOnlyKeys(entry, ["value", "label"]) ||
      typeof entry.value !== "string" ||
      entry.value.length === 0 ||
      (entry.label !== undefined &&
        (typeof entry.label !== "string" || entry.label.length === 0))
    ) {
      throw new Error("Local credential file contains an invalid credential entry");
    }
    credentials.set(ref, {
      value: entry.value,
      ...(entry.label === undefined ? {} : { label: entry.label }),
    });
  }
  const values = [...credentials.values()].map(({ value }) => value);
  if (
    [...credentials.values()].some(
      ({ label }) =>
        label !== undefined && values.some((value) => label.includes(value)),
    )
  ) {
    throw new Error("Local credential file contains an invalid credential label");
  }
  return { credentials };
}

export class LocalFileCredentialStore implements CredentialStore {
  readonly #filePath: string;
  readonly #platform: NodeJS.Platform;

  constructor(options: LocalFileCredentialStoreOptions = {}) {
    const environment = options.environment ?? process.env;
    const configuredPath = environment.AGENTBENCH_CREDENTIAL_FILE;
    this.#filePath = resolve(
      options.cwd ?? process.cwd(),
      configuredPath === undefined || configuredPath === ""
        ? ".agentbench/credentials.json"
        : configuredPath,
    );
    this.#platform = options.platform ?? process.platform;
  }

  async listMetadata(): Promise<CredentialMetadata[]> {
    const file = await this.#load();
    if (file === undefined) return [];
    return [...file.credentials]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([ref, credential]) => ({
        ref,
        ...(credential.label === undefined ? {} : { label: credential.label }),
        source: "local-file",
        configured: true,
      }));
  }

  async has(ref: string): Promise<boolean> {
    return (await this.#load())?.credentials.has(ref) ?? false;
  }

  async withCredential<T>(
    ref: string,
    callback: (secret: SecretValue) => Promise<T>,
  ): Promise<T> {
    const credential = (await this.#load())?.credentials.get(ref);
    if (credential === undefined) {
      throw new Error("Credential reference is not configured");
    }
    return SecretValue.withValue(credential.value, callback);
  }

  async #load(): Promise<LocalCredentialFile | undefined> {
    let stats;
    try {
      stats = await lstat(this.#filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Local credential file could not be inspected");
    }

    if (!stats.isFile()) {
      throw new Error("Local credential file must be a regular file");
    }
    if (this.#platform !== "win32" && !isSecureCredentialFileMode(stats.mode)) {
      throw new Error(
        "Local credential file must have owner-readable and owner-only permissions",
      );
    }

    let raw: string;
    try {
      raw = await readFile(this.#filePath, "utf8");
    } catch {
      throw new Error("Local credential file could not be read");
    }
    return parseCredentialFile(raw);
  }
}
