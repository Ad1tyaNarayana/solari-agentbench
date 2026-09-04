export type RedactionContext = {
  localRoots?: string[];
  exactValues?: readonly string[];
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isCredentialShapedKey(key: string): boolean {
  const canonical = key.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return (
    canonical === "auth" ||
    canonical === "key" ||
    canonical === "sig" ||
    /apikey|authorization|credential|jwt|secret|signature|token/.test(canonical)
  );
}

function redactCredentialUrls(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>\[\]{},]+/gi, (candidate) => {
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      return candidate;
    }
    if (parsed.hostname.toLowerCase().endsWith("getsolari.com")) {
      return "[REDACTED_SOLARI_URL]";
    }
    if (
      [...parsed.searchParams.keys()].some((key) =>
        isCredentialShapedKey(key),
      )
    ) {
      return "[REDACTED_SIGNED_URL]";
    }
    return candidate;
  });
}

function redactCredentialAssignments(value: string): string {
  return value.replace(
    /((?:["']?(?:api[_-]?key|authorization|credential|secret|session[_-]?token|signature|sig|token)["']?)\s*[:=]\s*)(["']?)(?!\[REDACTED\])([^\s"',;&}\]]+)\2/gi,
    (_match, prefix: string, quote: string) =>
      `${prefix}${quote}[REDACTED]${quote}`,
  );
}

export function redact(value: string, context: RedactionContext = {}): string {
  let sanitized = redactCredentialAssignments(redactCredentialUrls(value))
    .replace(/\bBearer\s+(?!\[REDACTED\])[^\s"'},\]]+/gi, "Bearer [REDACTED]")
    .replace(/\bslr_(?:live|test)_[A-Za-z0-9_-]+\b/g, "[REDACTED_SOLARI_KEY]");

  for (const root of context.localRoots ?? []) {
    sanitized = sanitized.replace(
      new RegExp(escapeRegExp(root), "gi"),
      "[REDACTED_LOCAL_PATH]",
    );
  }
  for (const exactValue of [...(context.exactValues ?? [])].sort(
    (left, right) => right.length - left.length,
  )) {
    if (exactValue.length > 0) {
      sanitized = sanitized.split(exactValue).join("[REDACTED]");
    }
  }
  return sanitized;
}
