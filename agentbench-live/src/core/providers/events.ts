import { ProviderProtocolError } from "./errors";

export type AgentEventKind =
  | "message"
  | "reasoning-summary"
  | "tool-request"
  | "tool-result"
  | "resource-created"
  | "resource-observation"
  | "artifact"
  | "usage"
  | "warning"
  | "error";

export type AgentEvent = {
  schemaVersion: 1;
  sequence: number;
  occurredAt: string;
  kind: AgentEventKind;
  provider: string;
  payload: unknown;
};

export interface AgentEventSink {
  emit(kind: AgentEventKind, payload: unknown): Promise<void>;
  close(): void;
}

export type CreateAgentEventSinkOptions = {
  provider: string;
  redact(value: string): string;
  publish(event: AgentEvent): void;
  now?: () => string;
};

function deepRedact(
  value: unknown,
  redact: (value: string) => string,
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (typeof value === "string") return redact(value);
  if (value === null || typeof value !== "object") return value;

  const known = seen.get(value);
  if (known !== undefined) return known;

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    for (const item of value) result.push(deepRedact(item, redact, seen));
    return result;
  }

  const result: Record<string, unknown> = {};
  seen.set(value, result);
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: deepRedact(item, redact, seen),
    });
  }
  return result;
}

export function createAgentEventSink(
  options: CreateAgentEventSinkOptions,
): AgentEventSink {
  let closed = false;
  let nextSequence = 1;
  let publicationTail = Promise.resolve();

  return {
    async emit(kind, payload) {
      if (closed) {
        throw new ProviderProtocolError(
          `Provider ${options.provider} emitted ${kind} after its event sink closed`,
          options.provider,
        );
      }

      const event: AgentEvent = {
        schemaVersion: 1,
        sequence: nextSequence,
        occurredAt: (options.now ?? (() => new Date().toISOString()))(),
        kind,
        provider: options.provider,
        payload: deepRedact(payload, options.redact),
      };
      nextSequence += 1;

      const publication = publicationTail.then(() => options.publish(event));
      publicationTail = publication.then(
        () => undefined,
        () => undefined,
      );
      await publication;
    },
    close() {
      closed = true;
    },
  };
}
