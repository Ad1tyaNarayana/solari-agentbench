import {
  isCredentialShapedKey,
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

    const result = Object.create(null) as Record<string, unknown>;
    seen.set(item, result);
    for (const [key, child] of Object.entries(item)) {
      result[redactCredentialText(key, snapshot, context)] =
        isCredentialShapedKey(key) ? "[REDACTED]" : visit(child);
    }
    return result;
  }

  return visit(value);
}

export function redactCredentialError(
  error: unknown,
  snapshot = snapshotCredentialRedaction(),
): unknown {
  const seen = new WeakMap<object, unknown>();
  const coercionKeys = new Set<PropertyKey>([
    "toString",
    "valueOf",
    Symbol.toPrimitive,
  ]);

  function sanitizeString(value: string, redactAllStrings: boolean): string {
    const sanitized = redactCredentialText(value, snapshot);
    if (redactAllStrings && sanitized === value) return "[REDACTED]";
    return sanitized;
  }

  function defineSafeProperty(
    target: object,
    key: string,
    value: unknown,
    enumerable: boolean,
  ): void {
    Object.defineProperty(target, key, {
      value,
      enumerable,
      writable: true,
      configurable: true,
    });
  }

  function copyDataProperties(
    source: object,
    target: object,
    skipped: ReadonlySet<PropertyKey>,
    redactAllStrings: boolean,
  ): void {
    for (const key of Reflect.ownKeys(source)) {
      if (skipped.has(key) || coercionKeys.has(key) || typeof key === "symbol") {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (descriptor === undefined) continue;
      const safeKey = redactCredentialText(key, snapshot);
      const sensitive = redactAllStrings || isCredentialShapedKey(key);
      const safeValue = sensitive
        ? "[REDACTED]"
        : "value" in descriptor
          ? sanitize(descriptor.value, false)
          : "[REDACTED_ACCESSOR]";
      defineSafeProperty(target, safeKey, safeValue, descriptor.enumerable ?? false);
    }
  }

  function errorKind(value: Error): {
    name: string;
    create(message: string): Error;
  } {
    if (value instanceof AggregateError) {
      return { name: "AggregateError", create: (message) => new AggregateError([], message) };
    }
    if (value instanceof TypeError) {
      return { name: "TypeError", create: (message) => new TypeError(message) };
    }
    if (value instanceof RangeError) {
      return { name: "RangeError", create: (message) => new RangeError(message) };
    }
    if (value instanceof ReferenceError) {
      return { name: "ReferenceError", create: (message) => new ReferenceError(message) };
    }
    if (value instanceof SyntaxError) {
      return { name: "SyntaxError", create: (message) => new SyntaxError(message) };
    }
    if (value instanceof URIError) {
      return { name: "URIError", create: (message) => new URIError(message) };
    }
    if (value instanceof EvalError) {
      return { name: "EvalError", create: (message) => new EvalError(message) };
    }
    return { name: "Error", create: (message) => new Error(message) };
  }

  function cloneError(value: Error): Error {
    const messageDescriptor = Object.getOwnPropertyDescriptor(value, "message");
    const message =
      messageDescriptor !== undefined &&
      "value" in messageDescriptor &&
      typeof messageDescriptor.value === "string"
        ? sanitizeString(messageDescriptor.value, false)
        : "Provider operation failed";
    const kind = errorKind(value);
    const result = kind.create(message);
    seen.set(value, result);
    result.name = kind.name;

    const stackDescriptor = Object.getOwnPropertyDescriptor(value, "stack");
    if (
      stackDescriptor !== undefined &&
      "value" in stackDescriptor &&
      typeof stackDescriptor.value === "string"
    ) {
      result.stack = sanitizeString(stackDescriptor.value, false);
    }

    const causeDescriptor = Object.getOwnPropertyDescriptor(value, "cause");
    if (causeDescriptor !== undefined) {
      defineSafeProperty(
        result,
        "cause",
        "value" in causeDescriptor
          ? sanitize(causeDescriptor.value, false)
          : "[REDACTED_ACCESSOR]",
        causeDescriptor.enumerable ?? false,
      );
    }

    if (result instanceof AggregateError) {
      const errorsDescriptor = Object.getOwnPropertyDescriptor(value, "errors");
      defineSafeProperty(
        result,
        "errors",
        errorsDescriptor !== undefined && "value" in errorsDescriptor
          ? sanitize(errorsDescriptor.value, false)
          : [],
        false,
      );
    }

    copyDataProperties(
      value,
      result,
      new Set(["name", "message", "stack", "cause", "errors"]),
      false,
    );
    return result;
  }

  function sanitize(value: unknown, redactAllStrings: boolean): unknown {
    if (typeof value === "string") return sanitizeString(value, redactAllStrings);
    if (typeof value === "function") return "[REDACTED_FUNCTION]";
    if (typeof value === "symbol" || typeof value === "bigint") return "[REDACTED]";
    if (value === null || typeof value !== "object") return value;

    const known = seen.get(value);
    if (known !== undefined) return known;
    if (value instanceof Error) return cloneError(value);

    const result: unknown[] | Record<string, unknown> = Array.isArray(value)
      ? []
      : Object.create(null) as Record<string, unknown>;
    seen.set(value, result);
    copyDataProperties(value, result, new Set(["length"]), redactAllStrings);
    return result;
  }

  try {
    return sanitize(error, false);
  } catch {
    return new Error("Provider operation failed");
  }
}
