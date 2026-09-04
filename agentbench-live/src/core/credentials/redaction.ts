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

  function sensitiveKey(key: string): boolean {
    const normalized = key
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase();
    return /(?:^|[_-])(?:api[_-]?key|authorization|credential|secret|signature|sig|token)(?:$|[_-])/.test(
      normalized,
    );
  }

  function visit(item: unknown, redactAllStrings = false): unknown {
    if (typeof item === "string") {
      const sanitized = redactCredentialText(item, snapshot, context);
      if (redactAllStrings && sanitized === item) return "[REDACTED]";
      return sanitized;
    }
    if (item === null || typeof item !== "object") return item;

    const known = seen.get(item);
    if (known !== undefined) return known;
    if (Array.isArray(item)) {
      const result: unknown[] = [];
      seen.set(item, result);
      for (const child of item) result.push(visit(child, redactAllStrings));
      return result;
    }

    const result: Record<string, unknown> = {};
    seen.set(item, result);
    for (const [key, child] of Object.entries(item)) {
      result[redactCredentialText(key, snapshot, context)] = visit(
        child,
        redactAllStrings || sensitiveKey(key),
      );
    }
    return result;
  }

  return visit(value);
}

export function redactCredentialError(
  error: unknown,
  snapshot = snapshotCredentialRedaction(),
): unknown {
  try {
    const seen = new WeakSet<object>();

    function sanitize(value: unknown): unknown {
      if (typeof value === "string") {
        return redactCredentialText(value, snapshot);
      }
      if (value === null || typeof value !== "object") return value;
      if (seen.has(value)) return value;
      seen.add(value);

      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !("value" in descriptor)) continue;

        const sanitizedValue = sanitize(descriptor.value);
        const sanitizedKey =
          typeof key === "string"
            ? redactCredentialText(key, snapshot)
            : key;
        const sanitizedDescriptor = {
          ...descriptor,
          value: sanitizedValue,
        };

        if (sanitizedKey !== key) {
          if (!descriptor.configurable || !Reflect.deleteProperty(value, key)) {
            throw new Error("Cannot safely redact credential-scoped error state");
          }
          Object.defineProperty(value, sanitizedKey, sanitizedDescriptor);
        } else if (sanitizedValue !== descriptor.value) {
          Object.defineProperty(value, key, sanitizedDescriptor);
        }
      }
      return value;
    }

    return sanitize(error);
  } catch {
    return new Error("Credential-scoped operation failed");
  }
}
