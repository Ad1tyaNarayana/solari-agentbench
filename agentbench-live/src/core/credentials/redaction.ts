import {
  redact,
  type RedactionContext,
} from "@/core/security/redact";

const activeValues = new Map<string, number>();

export type CredentialRedactionSnapshot = Readonly<{
  exactValues: readonly string[];
}>;

export function registerCredentialValue(value: string): () => void {
  activeValues.set(value, (activeValues.get(value) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = activeValues.get(value);
    if (count === undefined || count <= 1) activeValues.delete(value);
    else activeValues.set(value, count - 1);
  };
}

export function snapshotCredentialRedaction(): CredentialRedactionSnapshot {
  const exactValues = Object.freeze(
    [...activeValues.keys()].sort(
      (left, right) => right.length - left.length || left.localeCompare(right),
    ),
  );
  return Object.freeze({ exactValues });
}

export function redactCredentialText(
  value: string,
  snapshot = snapshotCredentialRedaction(),
  context: Omit<RedactionContext, "exactValues"> = {},
): string {
  return redact(value, { ...context, exactValues: snapshot.exactValues });
}

export function redactCredentialOutput(
  value: unknown,
  snapshot = snapshotCredentialRedaction(),
  context: Omit<RedactionContext, "exactValues"> = {},
): unknown {
  const seen = new WeakMap<object, unknown>();

  function visit(item: unknown): unknown {
    if (typeof item === "string") {
      return redactCredentialText(item, snapshot, context);
    }
    if (item === null || typeof item !== "object") return item;

    const known = seen.get(item);
    if (known !== undefined) return known;
    if (Array.isArray(item)) {
      const result: unknown[] = [];
      seen.set(item, result);
      for (const child of item) result.push(visit(child));
      return result;
    }

    const result: Record<string, unknown> = {};
    seen.set(item, result);
    for (const [key, child] of Object.entries(item)) {
      result[redactCredentialText(key, snapshot, context)] = visit(child);
    }
    return result;
  }

  return visit(value);
}

export function redactCredentialError(
  error: unknown,
  snapshot = snapshotCredentialRedaction(),
): unknown {
  if (!(error instanceof Error)) {
    return redactCredentialOutput(error, snapshot);
  }

  try {
    error.message = redactCredentialText(error.message, snapshot);
    if (error.stack !== undefined) {
      error.stack = redactCredentialText(error.stack, snapshot);
    }
    for (const key of Object.keys(error)) {
      Object.assign(error, {
        [key]: redactCredentialOutput(
          (error as unknown as Record<string, unknown>)[key],
          snapshot,
        ),
      });
    }
    if ("cause" in error && error.cause !== undefined) {
      error.cause = redactCredentialError(error.cause, snapshot);
    }
    return error;
  } catch {
    return new Error("Credential-scoped operation failed");
  }
}
