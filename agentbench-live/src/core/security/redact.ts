import { isCredentialShapedKey } from "./redaction-keys";

export { isCredentialShapedKey } from "./redaction-keys";

export type RedactionContext = {
  localRoots?: string[];
  exactValues?: readonly string[];
};

const KEY_MAX_CODE_POINTS = 128;
const whitespace = /\s/u;
const redactionPlaceholder = /^\[REDACTED(?:_[A-Z0-9]+)*\]$/;

type AssignmentKey = { value: string; delimiterIndex: number; start: number };
type ValueRange = { start: number; end: number; resumeAt: number };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && whitespace.test(character);
}

function isContainerBoundary(character: string | undefined): boolean {
  return (
    character === "{" || character === "}" || character === "[" ||
    character === "]" || character === "(" || character === ")" ||
    character === "<" || character === ">" || character === "," ||
    character === ";" || character === "&"
  );
}

function isUnquotedKeyCharacter(character: string | undefined): boolean {
  return !(
    character === undefined || isWhitespace(character) || character === '"' ||
    character === "'" || character === ":" || character === "=" ||
    isContainerBoundary(character)
  );
}

function assignmentDelimiterAfter(value: string, keyEnd: number): number | undefined {
  let cursor = keyEnd;
  while (cursor < value.length && isWhitespace(value[cursor])) cursor += 1;
  return value[cursor] === ":" || value[cursor] === "=" ? cursor : undefined;
}

function decodeQuotedKey(raw: string, quote: string): string | undefined {
  try {
    if (quote === '"') return JSON.parse(`"${raw}"`) as string;
    const jsonBody = raw.replace(/\\'/g, "'").replace(/(^|[^\\])"/g, '$1\\"');
    return JSON.parse(`"${jsonBody}"`) as string;
  } catch {
    return undefined;
  }
}

function quotedKeyAt(value: string, start: number): AssignmentKey | undefined {
  const quote = value[start];
  if (quote !== '"' && quote !== "'") return undefined;
  let cursor = start + 1;
  while (cursor < value.length) {
    if (value[cursor] === "\\" && cursor + 1 < value.length) {
      cursor += 2;
      continue;
    }
    if (value[cursor] === quote) {
      const decoded = decodeQuotedKey(value.slice(start + 1, cursor), quote);
      if (!decoded || [...decoded].length > KEY_MAX_CODE_POINTS) return undefined;
      const delimiterIndex = assignmentDelimiterAfter(value, cursor + 1);
      return delimiterIndex === undefined
        ? undefined
        : { value: decoded, delimiterIndex, start };
    }
    cursor += 1;
  }
  return undefined;
}

function unquotedKeyAt(value: string, start: number): { key?: AssignmentKey; resumeAt: number } {
  let end = start;
  while (end < value.length && isUnquotedKeyCharacter(value[end])) end += 1;
  const raw = value.slice(start, end);
  if ([...raw].length > KEY_MAX_CODE_POINTS) return { resumeAt: end };
  const delimiterIndex = assignmentDelimiterAfter(value, end);
  return {
    ...(delimiterIndex === undefined ? {} : { key: { value: raw, delimiterIndex, start } }),
    resumeAt: end,
  };
}

function quotedValueRange(value: string, contentStart: number, quote: string): ValueRange | undefined {
  let cursor = contentStart;
  while (cursor < value.length) {
    if (value[cursor] === "\\" && cursor + 1 < value.length) {
      cursor += 2;
      continue;
    }
    if (value[cursor] === quote) {
      return cursor > contentStart
        ? { start: contentStart, end: cursor, resumeAt: cursor + 1 }
        : undefined;
    }
    cursor += 1;
  }
  return cursor > contentStart
    ? { start: contentStart, end: cursor, resumeAt: cursor }
    : undefined;
}

function isUnquotedValueTerminator(
  character: string | undefined,
  allowQuotes: boolean,
): boolean {
  return (
    character === undefined || isWhitespace(character) ||
    (!allowQuotes && (character === '"' || character === "'")) ||
    character === "," || character === ";" ||
    character === "&" || character === "}" || character === "]" ||
    character === ")" || character === ">"
  );
}

function valueAfter(
  value: string,
  key: AssignmentKey,
  allowQuotes: boolean,
): ValueRange | undefined {
  let start = key.delimiterIndex + 1;
  while (start < value.length && isWhitespace(value[start])) start += 1;
  if (start === value.length) return undefined;
  const openingQuote = value[start];
  if (openingQuote === '"' || openingQuote === "'") {
    return quotedValueRange(value, start + 1, openingQuote);
  }
  const enclosingQuote = value[key.start - 1];
  if (enclosingQuote === '"' || enclosingQuote === "'") {
    return quotedValueRange(value, start, enclosingQuote);
  }
  let end = start;
  while (end < value.length && !isUnquotedValueTerminator(value[end], allowQuotes)) end += 1;
  return end > start ? { start, end, resumeAt: end } : undefined;
}

function isAlreadyRedacted(
  value: string,
  range: ValueRange,
  allowQuotes: boolean,
): boolean {
  let end = range.end;
  if (value[end] === "]") end += 1;
  return redactionPlaceholder.test(value.slice(range.start, end)) &&
    (end === value.length || isUnquotedValueTerminator(value[end], allowQuotes));
}

function redactAssignments(value: string, allowQuotes = false): string {
  const ranges: ValueRange[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    let key: AssignmentKey | undefined;
    let resumeAt = cursor + 1;
    const character = value[cursor];
    if (character === '"' || character === "'") {
      key = quotedKeyAt(value, cursor);
    } else if (isUnquotedKeyCharacter(character) && !isUnquotedKeyCharacter(value[cursor - 1])) {
      const candidate = unquotedKeyAt(value, cursor);
      key = candidate.key;
      resumeAt = candidate.resumeAt;
    }
    if (key === undefined) {
      cursor = resumeAt;
      continue;
    }
    if (!isCredentialShapedKey(key.value)) {
      cursor = key.delimiterIndex + 1;
      continue;
    }
    const range = valueAfter(value, key, allowQuotes);
    if (range === undefined) {
      cursor = key.delimiterIndex + 1;
      continue;
    }
    if (!isAlreadyRedacted(value, range, allowQuotes)) ranges.push(range);
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

function replaceLiteralSecrets(value: string, context: RedactionContext): string {
  let sanitized = value
    .replace(/\bBearer\s+(?!\[REDACTED\])[^\s"'},\]]+/gi, "Bearer [REDACTED]")
    .replace(/\bslr_(?:live|test)_[A-Za-z0-9_-]+\b/g, "[REDACTED_SOLARI_KEY]");
  for (const root of context.localRoots ?? []) {
    if (root.length === 0) continue;
    sanitized = sanitized.replace(new RegExp(escapeRegExp(root), "gi"), "[REDACTED_LOCAL_PATH]");
  }
  for (const exactValue of [...(context.exactValues ?? [])].sort((a, b) => b.length - a.length)) {
    if (exactValue.length > 0) sanitized = sanitized.split(exactValue).join("[REDACTED]");
  }
  return sanitized;
}

function redactUrl(candidate: string, context: RedactionContext): string {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return replaceLiteralSecrets(redactAssignments(candidate), context);
  }
  if (parsed.hostname.toLowerCase().endsWith("getsolari.com")) return "[REDACTED_SOLARI_URL]";
  if (
    parsed.username.length > 0 || parsed.password.length > 0 ||
    [...parsed.searchParams.keys()].some(isCredentialShapedKey) ||
    (context.exactValues ?? []).some((secret) => secret.length > 0 && candidate.includes(secret))
  ) return "[REDACTED_SIGNED_URL]";
  return candidate;
}

function redactFreeText(
  value: string,
  context: RedactionContext,
  decodedJsonString = false,
): string {
  const urlPattern = /https?:\/\/[^\s"'<>\[\]{},;()]+/gi;
  const parts: string[] = [];
  let copiedThrough = 0;
  for (const match of value.matchAll(urlPattern)) {
    const start = match.index;
    const candidate = match[0];
    parts.push(
      replaceLiteralSecrets(
        redactAssignments(value.slice(copiedThrough, start), decodedJsonString),
        context,
      ),
      redactUrl(candidate, context),
    );
    copiedThrough = start + candidate.length;
  }
  parts.push(
    replaceLiteralSecrets(
      redactAssignments(value.slice(copiedThrough), decodedJsonString),
      context,
    ),
  );
  return parts.join("");
}

function redactJsonValue(value: unknown, context: RedactionContext): unknown {
  if (typeof value === "string") return redactFreeText(value, context, true);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, context));
  const output = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value)) {
    const safeKey = redactFreeText(key, context);
    output[safeKey] = isCredentialShapedKey(key)
      ? "[REDACTED]"
      : redactJsonValue(child, context);
  }
  return output;
}

export function redact(value: string, context: RedactionContext = {}): string {
  try {
    return JSON.stringify(redactJsonValue(JSON.parse(value), context));
  } catch {
    return redactFreeText(value, context);
  }
}
