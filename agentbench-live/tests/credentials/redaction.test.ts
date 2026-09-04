import { expect, test } from "vitest";
import { EnvironmentCredentialStore } from "@/core/credentials/environment-store";
import {
  redactCredentialOutput,
  snapshotCredentialRedaction,
} from "@/core/credentials/redaction";
import { redact } from "@/core/security/redact";

function environmentStore(values: Record<string, string>) {
  const map: Record<string, string> = {};
  const environment: Record<string, string> = {};
  for (const [ref, value] of Object.entries(values)) {
    const variableName = `${ref.toUpperCase().replaceAll("-", "_")}_KEY`;
    map[ref] = variableName;
    environment[variableName] = value;
  }
  environment.AGENTBENCH_CREDENTIAL_ENV_MAP = JSON.stringify(map);
  return new EnvironmentCredentialStore({ environment });
}

test("redacts every active exact value from nested provider output", async () => {
  const store = environmentStore({
    short: "exact-secret",
    long: "exact-secret-with-suffix",
  });

  await store.withCredential("short", async () => {
    await store.withCredential("long", async () => {
      const snapshot = snapshotCredentialRedaction();
      const output = redactCredentialOutput(
        {
          message: "prefix exact-secret-with-suffix suffix",
          nested: ["exact-secret", { authorization: "Bearer ordinary-token" }],
        },
        snapshot,
      );

      expect(output).toEqual({
        message: "prefix [REDACTED] suffix",
        nested: ["[REDACTED]", { authorization: "Bearer [REDACTED]" }],
      });
      expect(JSON.stringify(output)).not.toMatch(/exact-secret|ordinary-token/);
    });
  });
});

test("keeps identical active values registered until every scope releases", async () => {
  const store = environmentStore({ first: "shared-secret", second: "shared-secret" });

  await store.withCredential("first", async () => {
    expect(snapshotCredentialRedaction().exactValues).toEqual(["shared-secret"]);

    await store.withCredential("second", async () => {
      expect(snapshotCredentialRedaction().exactValues).toEqual(["shared-secret"]);
    });

    expect(snapshotCredentialRedaction().exactValues).toEqual(["shared-secret"]);
  });

  expect(snapshotCredentialRedaction().exactValues).toEqual([]);
});

test("releases active values when a credential callback throws", async () => {
  const store = environmentStore({ api: "throwing-secret" });

  await expect(
    store.withCredential("api", async () => {
      throw new Error("provider failed");
    }),
  ).rejects.toThrow("provider failed");

  expect(snapshotCredentialRedaction().exactValues).toEqual([]);
});

test("redacts an error thrown from a credential callback before releasing scope", async () => {
  const store = environmentStore({ api: "error-secret-value" });
  const failure = Object.assign(
    new Error("request failed with error-secret-value"),
    { detail: { response: "echoed error-secret-value" } },
  );

  const rejection = await store
    .withCredential("api", async () => {
      throw failure;
    })
    .catch((error: unknown) => error);

  expect(rejection).toBe(failure);
  expect((rejection as Error).message).toBe("request failed with [REDACTED]");
  expect((rejection as Error & { detail: unknown }).detail).toEqual({
    response: "echoed [REDACTED]",
  });
  expect((rejection as Error).stack).not.toContain("error-secret-value");
  expect(snapshotCredentialRedaction().exactValues).toEqual([]);
});

test("returns an immutable snapshot for persistence and publication boundaries", async () => {
  const store = environmentStore({ api: "snapshot-secret" });

  await store.withCredential("api", async () => {
    const snapshot = snapshotCredentialRedaction();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.exactValues)).toBe(true);
    expect(
      redact("snapshot-secret", { exactValues: snapshot.exactValues }),
    ).toBe("[REDACTED]");
  });
});
