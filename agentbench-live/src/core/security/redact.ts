export type RedactionContext = {
  localRoots?: string[];
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redact(value: string, context: RedactionContext = {}): string {
  let sanitized = value
    .replace(/\bBearer\s+[^\s"'},\]]+/gi, "Bearer [REDACTED]")
    .replace(/\bslr_(?:live|test)_[A-Za-z0-9_-]+\b/g, "[REDACTED_SOLARI_KEY]")
    .replace(
      /https:\/\/[A-Za-z0-9.-]*getsolari\.com\/\S+/gi,
      "[REDACTED_SOLARI_URL]",
    );

  for (const root of context.localRoots ?? []) {
    sanitized = sanitized.replace(
      new RegExp(escapeRegExp(root), "gi"),
      "[REDACTED_LOCAL_PATH]",
    );
  }
  return sanitized;
}
