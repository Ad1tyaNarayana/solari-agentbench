export type RedactionContext = {
  localRoots?: string[];
  exactValues?: readonly string[];
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const sensitiveUrlParameters = new Set([
  "access_token",
  "api_key",
  "auth",
  "authorization",
  "credential",
  "expires",
  "id_token",
  "jwt",
  "key",
  "client_secret",
  "refresh_token",
  "session_token",
  "sig",
  "signature",
  "token",
  "x-amz-credential",
  "x-amz-signature",
]);

function isSensitiveUrlParameter(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  return (
    sensitiveUrlParameters.has(normalized) ||
    /(?:^|[_-])(?:auth|credential|jwt|secret|signature|sig|token)(?:$|[_-])/.test(
      normalized,
    )
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
        isSensitiveUrlParameter(key),
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
