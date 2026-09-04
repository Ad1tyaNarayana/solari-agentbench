import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { CompositeCredentialStore } from "@/core/credentials/composite-store";
import { EnvironmentCredentialStore } from "@/core/credentials/environment-store";
import { LocalFileCredentialStore } from "@/core/credentials/local-file-store";
import type { SecretValue } from "@/core/credentials/types";

const fixtureRoots: string[] = [];

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentbench-credentials-"));
  fixtureRoots.push(root);
  return root;
}

async function writeCredentialFile(
  root: string,
  contents: unknown,
  mode = 0o600,
): Promise<string> {
  const directory = join(root, ".agentbench");
  const path = join(directory, "credentials.json");
  await mkdir(directory, { recursive: true });
  await writeFile(path, JSON.stringify(contents), { mode });
  if (process.platform !== "win32") await chmod(path, mode);
  return path;
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("EnvironmentCredentialStore", () => {
  test("lists only explicitly mapped references without exposing values", async () => {
    const store = new EnvironmentCredentialStore({
      environment: {
        AGENTBENCH_CREDENTIAL_ENV_MAP: JSON.stringify({
          "anthropic-primary": "ANTHROPIC_API_KEY",
          "openai-missing": "OPENAI_API_KEY",
        }),
        ANTHROPIC_API_KEY: "environment-secret-value",
        UNRELATED_API_KEY: "must-never-be-enumerated",
      },
    });

    expect(await store.listMetadata()).toEqual([
      {
        configured: true,
        ref: "anthropic-primary",
        source: "environment",
      },
      {
        configured: false,
        ref: "openai-missing",
        source: "environment",
      },
    ]);
    expect(JSON.stringify(await store.listMetadata())).not.toMatch(
      /environment-secret-value|must-never-be-enumerated/,
    );
  });

  test("reports missing and empty mapped references as unavailable", async () => {
    const store = new EnvironmentCredentialStore({
      environment: {
        AGENTBENCH_CREDENTIAL_ENV_MAP: JSON.stringify({
          "empty-key": "EMPTY_KEY",
        }),
        EMPTY_KEY: "",
      },
    });

    await expect(store.has("empty-key")).resolves.toBe(false);
    await expect(store.has("unknown-key")).resolves.toBe(false);
    await expect(
      store.withCredential("unknown-key", async () => undefined),
    ).rejects.toThrow("Credential reference is not configured");
  });

  test("does not echo a secret-shaped missing reference in an error", async () => {
    const store = new EnvironmentCredentialStore({
      environment: {
        AGENTBENCH_CREDENTIAL_ENV_MAP: JSON.stringify({ api: "API_KEY" }),
        API_KEY: "secret-shaped-reference",
      },
    });

    const rejection = await store
      .withCredential("secret-shaped-reference", async () => undefined)
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).not.toContain("secret-shaped-reference");
  });

  test("reveals a secret only while its asynchronous callback is active", async () => {
    const store = new EnvironmentCredentialStore({
      environment: {
        AGENTBENCH_CREDENTIAL_ENV_MAP: JSON.stringify({ api: "API_KEY" }),
        API_KEY: "scoped-secret-value",
      },
    });
    let retained: SecretValue | undefined;

    const result = await store.withCredential("api", async (secret) => {
      retained = secret;
      expect(secret.reveal()).toBe("scoped-secret-value");
      await Promise.resolve();
      expect(secret.reveal()).toBe("scoped-secret-value");
      return "callback-result";
    });

    expect(result).toBe("callback-result");
    expect(retained?.toString()).toBe("[REDACTED]");
    expect(() => retained?.reveal()).toThrow(/outside its active scope/i);
  });

  test("never stringifies or JSON serializes a SecretValue", async () => {
    const store = new EnvironmentCredentialStore({
      environment: {
        AGENTBENCH_CREDENTIAL_ENV_MAP: JSON.stringify({ api: "API_KEY" }),
        API_KEY: "serialization-secret-value",
      },
    });

    await store.withCredential("api", async (secret) => {
      expect(String(secret)).toBe("[REDACTED]");
      expect(() => JSON.stringify({ secret })).toThrow(
        /SecretValue cannot be serialized/i,
      );
    });
  });

  test.each([
    ["malformed JSON", "{"],
    ["an array", "[]"],
    ["an invalid reference", JSON.stringify({ "Bad Ref": "API_KEY" })],
    ["an invalid variable name", JSON.stringify({ api: "API-KEY" })],
    ["a non-string variable name", JSON.stringify({ api: 123 })],
  ])("rejects %s in the explicit environment map", async (_name, map) => {
    expect(
      () =>
        new EnvironmentCredentialStore({
          environment: { AGENTBENCH_CREDENTIAL_ENV_MAP: map },
        }),
    ).toThrow(/AGENTBENCH_CREDENTIAL_ENV_MAP/);
  });
});

describe("LocalFileCredentialStore", () => {
  test("treats an absent optional credential file as an empty store", async () => {
    const root = await createFixtureRoot();
    const store = new LocalFileCredentialStore({ cwd: root, environment: {} });

    await expect(store.listMetadata()).resolves.toEqual([]);
    await expect(store.has("missing")).resolves.toBe(false);
  });

  test("returns metadata and scoped values from the strict local file", async () => {
    const root = await createFixtureRoot();
    await writeCredentialFile(root, {
      schemaVersion: 1,
      credentials: {
        "anthropic-primary": {
          value: "local-file-secret-value",
          label: "Anthropic",
        },
      },
    });
    const store = new LocalFileCredentialStore({ cwd: root, environment: {} });

    expect(await store.listMetadata()).toEqual([
      {
        configured: true,
        label: "Anthropic",
        ref: "anthropic-primary",
        source: "local-file",
      },
    ]);
    expect(JSON.stringify(await store.listMetadata())).not.toContain(
      "local-file-secret-value",
    );
    await expect(store.has("anthropic-primary")).resolves.toBe(true);
    await expect(
      store.withCredential("anthropic-primary", async (secret) =>
        secret.reveal(),
      ),
    ).resolves.toBe("local-file-secret-value");
  });

  test("uses AGENTBENCH_CREDENTIAL_FILE without exposing the file value", async () => {
    const root = await createFixtureRoot();
    const customPath = join(root, "private-credentials.json");
    await writeFile(
      customPath,
      JSON.stringify({
        schemaVersion: 1,
        credentials: { custom: { value: "custom-secret-value" } },
      }),
      { mode: 0o600 },
    );
    const store = new LocalFileCredentialStore({
      cwd: join(root, "unused"),
      environment: { AGENTBENCH_CREDENTIAL_FILE: customPath },
    });

    await expect(store.has("custom")).resolves.toBe(true);
    expect(JSON.stringify(await store.listMetadata())).not.toContain(
      "custom-secret-value",
    );
  });

  test.each([
    ["unknown root fields", { schemaVersion: 1, credentials: {}, extra: true }],
    ["the wrong schema version", { schemaVersion: 2, credentials: {} }],
    ["a non-object credential map", { schemaVersion: 1, credentials: [] }],
    [
      "invalid references",
      { schemaVersion: 1, credentials: { "Bad Ref": { value: "secret" } } },
    ],
    [
      "unknown entry fields",
      {
        schemaVersion: 1,
        credentials: { api: { value: "secret", extra: true } },
      },
    ],
    [
      "empty values",
      { schemaVersion: 1, credentials: { api: { value: "" } } },
    ],
    [
      "empty labels",
      { schemaVersion: 1, credentials: { api: { value: "secret", label: "" } } },
    ],
  ])("rejects %s without leaking parsed contents", async (_name, contents) => {
    const root = await createFixtureRoot();
    await writeCredentialFile(root, contents);
    const store = new LocalFileCredentialStore({ cwd: root, environment: {} });

    const rejection = await store.listMetadata().catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toMatch(/credential file/i);
    expect((rejection as Error).message).not.toContain("secret");
  });

  test("rejects labels containing a configured value before producing metadata", async () => {
    const root = await createFixtureRoot();
    await writeCredentialFile(root, {
      schemaVersion: 1,
      credentials: {
        api: { value: "label-secret-value", label: "Key label-secret-value" },
      },
    });
    const store = new LocalFileCredentialStore({ cwd: root, environment: {} });

    const rejection = await store.listMetadata().catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).not.toContain("label-secret-value");
  });

  test.skipIf(process.platform === "win32")(
    "rejects credential files readable by group or other users",
    async () => {
      const root = await createFixtureRoot();
      await writeCredentialFile(
        root,
        { schemaVersion: 1, credentials: {} },
        0o644,
      );
      const store = new LocalFileCredentialStore({ cwd: root, environment: {} });

      await expect(store.listMetadata()).rejects.toThrow(/owner-only permissions/i);
    },
  );
});

describe("CompositeCredentialStore", () => {
  test("combines unique stores and resolves the configured owner", async () => {
    const environmentStore = new EnvironmentCredentialStore({
      environment: {
        AGENTBENCH_CREDENTIAL_ENV_MAP: JSON.stringify({ env: "ENV_KEY" }),
        ENV_KEY: "environment-secret",
      },
    });
    const root = await createFixtureRoot();
    await writeCredentialFile(root, {
      schemaVersion: 1,
      credentials: { file: { value: "file-secret", label: "File" } },
    });
    const localStore = new LocalFileCredentialStore({
      cwd: root,
      environment: {},
    });
    const store = new CompositeCredentialStore([environmentStore, localStore]);

    expect(await store.listMetadata()).toEqual([
      { configured: true, ref: "env", source: "environment" },
      {
        configured: true,
        label: "File",
        ref: "file",
        source: "local-file",
      },
    ]);
    await expect(
      store.withCredential("file", async (secret) => secret.reveal()),
    ).resolves.toBe("file-secret");
  });

  test("rejects duplicate references across stores without hidden precedence", async () => {
    const first = new EnvironmentCredentialStore({
      environment: {
        AGENTBENCH_CREDENTIAL_ENV_MAP: JSON.stringify({ duplicate: "FIRST_KEY" }),
        FIRST_KEY: "first-secret-value",
      },
    });
    const second = new EnvironmentCredentialStore({
      environment: {
        AGENTBENCH_CREDENTIAL_ENV_MAP: JSON.stringify({ duplicate: "SECOND_KEY" }),
        SECOND_KEY: "second-secret-value",
      },
    });
    const store = new CompositeCredentialStore([first, second]);

    const rejection = await store.has("duplicate").catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toMatch(/duplicate/i);
    expect((rejection as Error).message).not.toMatch(
      /first-secret-value|second-secret-value/,
    );
  });

  test("rejects a duplicate mapped reference even when one source is missing", async () => {
    const configured = new EnvironmentCredentialStore({
      environment: {
        AGENTBENCH_CREDENTIAL_ENV_MAP: JSON.stringify({ duplicate: "SET_KEY" }),
        SET_KEY: "configured-value",
      },
    });
    const missing = new EnvironmentCredentialStore({
      environment: {
        AGENTBENCH_CREDENTIAL_ENV_MAP: JSON.stringify({ duplicate: "MISSING_KEY" }),
      },
    });
    const store = new CompositeCredentialStore([configured, missing]);

    await expect(store.listMetadata()).rejects.toThrow(/duplicate/i);
  });
});
