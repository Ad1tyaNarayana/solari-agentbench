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

test("redacts nested token fields, credential assignments, and signed URLs on any host", () => {
  const output = redactCredentialOutput({
    url: "https://preview.example.test/run?token=url-secret&mode=view",
    token: "nested-token-secret",
    nested: {
      authorization: "raw-authorization-secret",
      message: "token=assignment-secret Bearer bearer-secret",
    },
  });

  expect(output).toEqual({
    url: "[REDACTED_SIGNED_URL]",
    token: "[REDACTED]",
    nested: {
      authorization: "[REDACTED]",
      message: "token=[REDACTED] Bearer [REDACTED]",
    },
  });
  expect(JSON.stringify(output)).not.toMatch(
    /url-secret|nested-token-secret|raw-authorization-secret|assignment-secret|bearer-secret/,
  );
});

test("redacts JWT and common auth query parameters case-insensitively on any host", () => {
  const output = redactCredentialOutput({
    jwt: "https://identity.example.test/callback?JWT=jwt-secret",
    refresh: "https://identity.example.test/callback?refresh_token=refresh-secret",
    client: "https://identity.example.test/callback?client_secret=client-secret",
    camel: "https://identity.example.test/callback?accessToken=camel-secret",
  });

  expect(output).toEqual({
    jwt: "[REDACTED_SIGNED_URL]",
    refresh: "[REDACTED_SIGNED_URL]",
    client: "[REDACTED_SIGNED_URL]",
    camel: "[REDACTED_SIGNED_URL]",
  });
  expect(JSON.stringify(output)).not.toMatch(
    /jwt-secret|refresh-secret|client-secret|camel-secret/,
  );
});

test("canonicalizes weird-case and separated credential keys in URLs and nested objects", () => {
  const output = redactCredentialOutput({
    urls: [
      "https://one.example.test/path?jWt=url-jwt-secret",
      "https://two.example.test/path?A.p-I__K_eY=url-api-secret",
      "https://three.example.test/path?AcCeSs---To_Ken=url-token-secret",
    ],
    nested: {
      jWT: "nested-jwt-secret",
      "A.p-I__K_eY": "nested-api-secret",
      "sIG--n_a.tURE": "nested-signature-secret",
      "cre-D.en_TI_al": "nested-credential-secret",
      "s_E.c-R_eT": "nested-generic-secret",
    },
  });

  expect(output).toEqual({
    urls: [
      "[REDACTED_SIGNED_URL]",
      "[REDACTED_SIGNED_URL]",
      "[REDACTED_SIGNED_URL]",
    ],
    nested: {
      jWT: "[REDACTED]",
      "A.p-I__K_eY": "[REDACTED]",
      "sIG--n_a.tURE": "[REDACTED]",
      "cre-D.en_TI_al": "[REDACTED]",
      "s_E.c-R_eT": "[REDACTED]",
    },
  });
  expect(JSON.stringify(output)).not.toMatch(
    /url-jwt-secret|url-api-secret|url-token-secret|nested-.*-secret/,
  );
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

  expect(rejection === failure).toBe(false);
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).message).toBe("request failed with [REDACTED]");
  expect((rejection as Error & { detail: unknown }).detail).toEqual({
    response: "echoed [REDACTED]",
  });
  expect((rejection as Error).stack).not.toContain("error-secret-value");
  expect(snapshotCredentialRedaction().exactValues).toEqual([]);
});

test("redacts non-enumerable and cyclic error state while preserving error shapes", async () => {
  const secret = "aggregate-error-secret";
  const store = environmentStore({ api: secret });
  const cause = new RangeError(`cause ${secret}`);
  cause.name = `Cause-${secret}`;
  const nested = new TypeError(`nested ${secret}`);
  nested.name = `Nested-${secret}`;
  const failure = new AggregateError(
    [nested, `string ${secret}`],
    `aggregate ${secret}`,
    { cause },
  );
  failure.name = `Aggregate-${secret}`;
  const detail: { token: string; self?: unknown } = { token: secret };
  detail.self = detail;
  Object.assign(failure, { detail });
  failure.errors.push(failure);

  const rejection = await store
    .withCredential("api", async () => {
      throw failure;
    })
    .catch((error: unknown) => error);

  expect(rejection === failure).toBe(false);
  expect(rejection).toBeInstanceOf(AggregateError);
  const safe = rejection as AggregateError & { detail: typeof detail };
  expect(String(safe)).not.toContain(secret);
  expect(safe.name).toBe("AggregateError");
  expect(safe.cause === cause).toBe(false);
  expect(safe.cause).toBeInstanceOf(RangeError);
  expect(String(safe.cause)).not.toContain(secret);
  expect((safe.cause as Error).name).toBe("RangeError");
  expect(safe.errors[0] === nested).toBe(false);
  expect(safe.errors[0]).toBeInstanceOf(TypeError);
  expect(String(safe.errors[0])).not.toContain(secret);
  expect(safe.errors[1]).toBe("string [REDACTED]");
  expect(safe.errors[2]).toBe(safe);
  expect(safe.detail).toMatchObject({
    token: "[REDACTED]",
  });
  expect(safe.detail === detail).toBe(false);
  expect(safe.detail.self).toBe(safe.detail);
});

test("redacts an Error name inherited from its provider-defined prototype", async () => {
  const secret = "prototype-name-secret";
  const store = environmentStore({ api: secret });
  class ProviderError extends Error {}
  Object.defineProperty(ProviderError.prototype, "name", {
    value: `Provider-${secret}`,
    configurable: true,
  });
  const failure = new ProviderError("provider failed");

  const rejection = await store
    .withCredential("api", async () => {
      throw failure;
    })
    .catch((error: unknown) => error);

  expect(rejection === failure).toBe(false);
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).name).toBe("Error");
  expect(String(rejection)).not.toContain(secret);
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
