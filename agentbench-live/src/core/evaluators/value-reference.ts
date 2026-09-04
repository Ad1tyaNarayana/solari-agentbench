import { posix } from "node:path";
import type { EvaluatorContext } from "./types";

function safeSubmissionPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) throw new Error("Value reference path escapes submission");
  return posix.normalize(normalized);
}

export function jsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) throw new Error("JSON Pointer must begin with /");
  return pointer.slice(1).split("/").reduce<unknown>((current, raw) => {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current === null || typeof current !== "object" || !(key in current)) throw new Error(`JSON Pointer not found: ${pointer}`);
    return (current as Record<string, unknown>)[key];
  }, value);
}

export function resolveValue(value: unknown, context: EvaluatorContext): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const item = value as Record<string, unknown>;
    if (typeof item.fromEvaluator === "string" && typeof item.output === "string" && Object.keys(item).length === 2) return context.resources.getOutput(item.fromEvaluator, item.output);
    if (typeof item.file === "string" && typeof item.pointer === "string" && Object.keys(item).length === 2) {
      const entry = context.submission.entries[safeSubmissionPath(item.file)];
      if (!entry || entry.kind !== "text") throw new Error(`JSON submission file not found: ${item.file}`);
      return jsonPointer(JSON.parse(entry.contents), item.pointer);
    }
  }
  return value;
}
