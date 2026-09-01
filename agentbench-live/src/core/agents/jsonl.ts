import { redact, type RedactionContext } from "@/core/security/redact";

export type JsonlEvent = Record<string, unknown>;

export function parseJsonl(
  value: string,
  context: RedactionContext = {},
): JsonlEvent[] {
  const events: JsonlEvent[] = [];
  for (const rawLine of value.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const line = redact(rawLine, context);
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        events.push(parsed as JsonlEvent);
      }
    } catch {
      // Non-JSON diagnostic lines remain available in sanitized stdout.
    }
  }
  return events;
}
