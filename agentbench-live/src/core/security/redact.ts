export type RedactionContext = {
  localRoots?: string[];
  exactValues?: readonly string[];
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function canonicalizeCredentialKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function isCredentialShapedKey(key: string): boolean {
  const canonical = canonicalizeCredentialKey(key);
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

const CREDENTIAL_ASSIGNMENT_KEY_MAX_LENGTH = 128;
const whitespace = /\s/u;
const redactionPlaceholder = /^\[REDACTED(?:_[A-Z0-9]+)*\]$/;

type AssignmentValueRange = {
  start: number;
  end: number;
  resumeAt: number;
  quoted: boolean;
};

type AssignmentKey = {
  value: string;
  quoted: boolean;
};

function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && whitespace.test(character);
}

function isAsciiAlphanumeric(character: string | undefined): boolean {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function isAssignmentContainerBoundary(
  character: string | undefined,
): boolean {
  return (
    character === "{" ||
    character === "}" ||
    character === "[" ||
    character === "]" ||
    character === "(" ||
    character === ")" ||
    character === "<" ||
    character === ">" ||
    character === "," ||
    character === ";" ||
    character === "&"
  );
}

function isAssignmentKeyCharacter(
  character: string | undefined,
  matchingQuote?: '"' | "'",
): boolean {
  if (isAsciiAlphanumeric(character)) return true;
  if (
    character === undefined ||
    character === ":" ||
    character === "=" ||
    isAssignmentContainerBoundary(character)
  ) {
    return false;
  }
  if (character === '"' || character === "'") {
    return matchingQuote !== undefined && character !== matchingQuote;
  }
  // Every other character is a separator removed by key canonicalization.
  return true;
}

function assignmentKeyBefore(
  value: string,
  separatorIndex: number,
): AssignmentKey | undefined {
  let keyEnd = separatorIndex;
  while (keyEnd > 0 && isWhitespace(value[keyEnd - 1])) keyEnd -= 1;
  if (keyEnd === 0) return undefined;

  const quote = value[keyEnd - 1];
  if (quote === '"' || quote === "'") {
    const contentEnd = keyEnd - 1;
    const minimumIndex = Math.max(
      0,
      contentEnd - CREDENTIAL_ASSIGNMENT_KEY_MAX_LENGTH - 1,
    );
    let cursor = contentEnd - 1;
    while (cursor >= minimumIndex) {
      const character = value[cursor];
      if (character === quote) {
        let escapeStart = cursor;
        while (
          escapeStart > minimumIndex &&
          value[escapeStart - 1] === "\\"
        ) {
          escapeStart -= 1;
        }
        if (
          escapeStart === minimumIndex &&
          value[escapeStart - 1] === "\\"
        ) {
          return undefined;
        }
        if ((cursor - escapeStart) % 2 === 0) {
          const candidate = value.slice(cursor + 1, contentEnd);
          return candidate.length > 0
            ? { value: candidate, quoted: true }
            : undefined;
        }
        cursor = escapeStart - 1;
        continue;
      }
      if (!isAssignmentKeyCharacter(character, quote)) return undefined;
      cursor -= 1;
    }
    return undefined;
  }

  let keyStart = keyEnd;
  let remaining = CREDENTIAL_ASSIGNMENT_KEY_MAX_LENGTH;
  while (
    keyStart > 0 &&
    remaining > 0 &&
    isAssignmentKeyCharacter(value[keyStart - 1])
  ) {
    keyStart -= 1;
    remaining -= 1;
  }
  return keyStart < keyEnd
    ? { value: value.slice(keyStart, keyEnd), quoted: false }
    : undefined;
}

function isUnquotedAssignmentValueTerminator(
  character: string | undefined,
): boolean {
  return (
    character === undefined ||
    isWhitespace(character) ||
    character === '"' ||
    character === "'" ||
    character === "," ||
    character === ";" ||
    character === "&" ||
    character === "}" ||
    character === "]"
  );
}

function assignmentValueAfter(
  value: string,
  separatorIndex: number,
): AssignmentValueRange | undefined {
  let valueStart = separatorIndex + 1;
  while (valueStart < value.length && isWhitespace(value[valueStart])) {
    valueStart += 1;
  }
  if (valueStart === value.length) return undefined;

  const quote = value[valueStart];
  if (quote === '"' || quote === "'") {
    const contentStart = valueStart + 1;
    let cursor = contentStart;
    while (cursor < value.length) {
      const character = value[cursor];
      if (character === "\\" && cursor + 1 < value.length) {
        cursor += 2;
        continue;
      }
      if (character === quote) {
        return cursor > contentStart
          ? {
              start: contentStart,
              end: cursor,
              resumeAt: cursor + 1,
              quoted: true,
            }
          : undefined;
      }
      cursor += 1;
    }
    return cursor > contentStart
      ? { start: contentStart, end: cursor, resumeAt: cursor, quoted: true }
      : undefined;
  }

  let valueEnd = valueStart;
  while (
    valueEnd < value.length &&
    !isUnquotedAssignmentValueTerminator(value[valueEnd])
  ) {
    valueEnd += 1;
  }
  return valueEnd > valueStart
    ? { start: valueStart, end: valueEnd, resumeAt: valueEnd, quoted: false }
    : undefined;
}

function isJsonNumber(value: string, start: number, end: number): boolean {
  let cursor = start;
  if (value[cursor] === "-") cursor += 1;
  if (cursor === end) return false;

  if (value[cursor] === "0") {
    cursor += 1;
  } else {
    const first = value.charCodeAt(cursor);
    if (first < 49 || first > 57) return false;
    cursor += 1;
    while (cursor < end) {
      const digit = value.charCodeAt(cursor);
      if (digit < 48 || digit > 57) break;
      cursor += 1;
    }
  }

  if (value[cursor] === ".") {
    cursor += 1;
    const fractionStart = cursor;
    while (cursor < end) {
      const digit = value.charCodeAt(cursor);
      if (digit < 48 || digit > 57) break;
      cursor += 1;
    }
    if (cursor === fractionStart) return false;
  }

  if (value[cursor] === "e" || value[cursor] === "E") {
    cursor += 1;
    if (value[cursor] === "+" || value[cursor] === "-") cursor += 1;
    const exponentStart = cursor;
    while (cursor < end) {
      const digit = value.charCodeAt(cursor);
      if (digit < 48 || digit > 57) break;
      cursor += 1;
    }
    if (cursor === exponentStart) return false;
  }

  return cursor === end;
}

function isJsonNonStringPrimitive(
  value: string,
  range: AssignmentValueRange,
): boolean {
  if (range.quoted) return false;
  const length = range.end - range.start;
  return (
    (length === 4 &&
      (value.startsWith("true", range.start) ||
        value.startsWith("null", range.start))) ||
    (length === 5 && value.startsWith("false", range.start)) ||
    isJsonNumber(value, range.start, range.end)
  );
}

function isAlreadyRedactedAssignmentValue(
  value: string,
  range: AssignmentValueRange,
): boolean {
  let placeholderEnd = range.end;
  if (value[placeholderEnd] === "]") placeholderEnd += 1;
  if (!redactionPlaceholder.test(value.slice(range.start, placeholderEnd))) {
    return false;
  }
  return (
    placeholderEnd === value.length ||
    isUnquotedAssignmentValueTerminator(value[placeholderEnd])
  );
}

function redactCredentialAssignments(value: string): string {
  const ranges: AssignmentValueRange[] = [];
  for (let cursor = 0; cursor < value.length; cursor += 1) {
    if (value[cursor] !== ":" && value[cursor] !== "=") continue;
    const key = assignmentKeyBefore(value, cursor);
    if (key === undefined || !isCredentialShapedKey(key.value)) continue;
    const range = assignmentValueAfter(value, cursor);
    if (range === undefined) continue;
    if (key.quoted && value[cursor] === ":" && isJsonNonStringPrimitive(value, range)) {
      cursor = Math.max(cursor, range.resumeAt - 1);
      continue;
    }
    if (!isAlreadyRedactedAssignmentValue(value, range)) ranges.push(range);
    cursor = Math.max(cursor, range.resumeAt - 1);
  }
  if (ranges.length === 0) return value;

  const parts: string[] = [];
  let copiedThrough = 0;
  for (const range of ranges) {
    parts.push(value.slice(copiedThrough, range.start), "[REDACTED]");
    copiedThrough = range.end;
  }
  parts.push(value.slice(copiedThrough));
  return parts.join("");
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
