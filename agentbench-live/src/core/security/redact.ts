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
  delimiterIndex: number;
};

function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && whitespace.test(character);
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

function assignmentDelimiterAfter(
  value: string,
  keyEnd: number,
): number | undefined {
  let cursor = keyEnd;
  while (cursor < value.length && isWhitespace(value[cursor])) cursor += 1;
  return value[cursor] === ":" || value[cursor] === "="
    ? cursor
    : undefined;
}

function quotedAssignmentKeyAt(
  value: string,
  keyStart: number,
): AssignmentKey | undefined {
  const quote = value[keyStart];
  if (quote !== '"' && quote !== "'") return undefined;

  const contentStart = keyStart + 1;
  let cursor = contentStart;
  let escaped = false;
  while (
    cursor < value.length &&
    cursor - contentStart <= CREDENTIAL_ASSIGNMENT_KEY_MAX_LENGTH
  ) {
    const character = value[cursor];
    if (escaped) {
      escaped = false;
      cursor += 1;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      cursor += 1;
      continue;
    }
    if (character === quote) {
      if (cursor === contentStart) return undefined;
      const delimiterIndex = assignmentDelimiterAfter(value, cursor + 1);
      return delimiterIndex === undefined
        ? undefined
        : {
            value: value.slice(contentStart, cursor),
            quoted: true,
            delimiterIndex,
          };
    }
    cursor += 1;
  }
  return undefined;
}

function isUnquotedAssignmentKeyCharacter(
  character: string | undefined,
): boolean {
  // Everything canonicalization can discard remains admissible except syntax
  // that separates free-text assignments or delimits quoted keys.
  return !(
    character === undefined ||
    isWhitespace(character) ||
    character === '"' ||
    character === "'" ||
    character === ":" ||
    character === "=" ||
    isAssignmentContainerBoundary(character)
  );
}

function unquotedAssignmentKeyAt(
  value: string,
  keyStart: number,
): { key?: AssignmentKey; resumeAt: number } {
  let keyEnd = keyStart;
  while (
    keyEnd < value.length &&
    isUnquotedAssignmentKeyCharacter(value[keyEnd])
  ) {
    keyEnd += 1;
  }
  if (keyEnd - keyStart > CREDENTIAL_ASSIGNMENT_KEY_MAX_LENGTH) {
    return { resumeAt: keyEnd };
  }
  const delimiterIndex = assignmentDelimiterAfter(value, keyEnd);
  return {
    ...(delimiterIndex === undefined
      ? {}
      : {
          key: {
            value: value.slice(keyStart, keyEnd),
            quoted: false,
            delimiterIndex,
          },
        }),
    resumeAt: keyEnd,
  };
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
    character === "]" ||
    character === ")" ||
    character === ">"
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
  // The lexer cursor never retreats. Quoted-key lookahead is capped at 128
  // code units, and a matched value is scanned once before the cursor skips it.
  let cursor = 0;
  while (cursor < value.length) {
    let key: AssignmentKey | undefined;
    let unmatchedResumeAt = cursor + 1;
    const character = value[cursor];

    if (character === '"' || character === "'") {
      key = quotedAssignmentKeyAt(value, cursor);
    } else if (
      isUnquotedAssignmentKeyCharacter(character) &&
      !isUnquotedAssignmentKeyCharacter(value[cursor - 1])
    ) {
      const candidate = unquotedAssignmentKeyAt(value, cursor);
      key = candidate.key;
      unmatchedResumeAt = candidate.resumeAt;
    }

    if (key === undefined) {
      cursor = unmatchedResumeAt;
      continue;
    }

    if (!isCredentialShapedKey(key.value)) {
      cursor = key.delimiterIndex + 1;
      continue;
    }

    const range = assignmentValueAfter(value, key.delimiterIndex);
    if (range === undefined) {
      cursor = key.delimiterIndex + 1;
      continue;
    }
    if (
      key.quoted &&
      value[key.delimiterIndex] === ":" &&
      isJsonNonStringPrimitive(value, range)
    ) {
      cursor = range.resumeAt;
      continue;
    }
    if (!isAlreadyRedactedAssignmentValue(value, range)) ranges.push(range);
    cursor = range.resumeAt;
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
