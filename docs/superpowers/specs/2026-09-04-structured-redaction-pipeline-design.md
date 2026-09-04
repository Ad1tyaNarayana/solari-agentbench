# Structured Redaction Pipeline Design

## Problem

AgentBench publishes provider events, tool results, JSONL transcripts, and
detached errors. Those values may contain live credentials in structured JSON,
URLs, headers, or free text. A single assignment lexer cannot interpret all of
those grammars safely: it can corrupt valid JSON, miss escaped JSON keys, and
mistake a URL path such as `/oauth/token` for an assignment key.

## Goals

- Redact credential-shaped data before it is persisted or published.
- Preserve valid JSON as valid JSON, including arrays, objects, and primitive
  telemetry values.
- Preserve ordinary URLs and token-usage telemetry.
- Redact signed URLs, Solari URLs, bearer values, active exact secrets, and
  local workspace roots.
- Sanitize hostile detached errors without invoking accessors or coercion
  hooks.
- Keep the public `redact(value, context)` API and existing placeholder forms.

## Semantic key policy

Keys are canonicalized to lowercase ASCII alphanumerics. A key is sensitive
only when its canonical form is in this exact set:

`auth`, `authorization`, `key`, `sig`, `token`, `accessToken`, `authToken`,
`bearerToken`, `refreshToken`, `idToken`, `sessionToken`, `apiKey`, `jwt`,
`secret`, `clientSecret`, `signature`, `credential`, `password`, and
`passphrase`.

The matching set is stored in canonical form. It does not use substring
matching. Usage/container keys such as `tokens`, `input_tokens`,
`output_tokens`, `total_tokens`, `cached_tokens`, `token_count`,
`token_details`, `token_usage`, and `max_tokens` are therefore safe. Their
children are still visited normally, so a nested exact sensitive key is
redacted.

## Pipeline

`redact` first replaces registered exact values, local roots, Solari key
patterns, and bearer values. Placeholders are idempotent.

If the whole input parses as JSON, the structured branch recursively visits
the parsed value. For an exact sensitive object key it replaces the complete
value, including arrays and objects, with `"[REDACTED]"`. Other string leaves
are passed through the free-text sanitizer. Other primitive types retain their
types. The result is serialized with `JSON.stringify`, so escaped keys are
interpreted semantically and output is always valid JSON.

If the whole input is not JSON, the free-text branch works in two passes:

1. Identify conservative `http://` and `https://` spans and parse them with
   `URL`. A Solari host becomes `[REDACTED_SOLARI_URL]`. A URL with an exact
   sensitive query parameter or userinfo becomes `[REDACTED_SIGNED_URL]`.
   Ordinary URL spans are shielded from assignment scanning.
2. Scan only non-URL text for `key=value` and `key: value` assignments.
   Unquoted and quoted keys may contain punctuation; quoted keys decode
   JSON-style escapes for semantic matching while their original spelling is
   retained. Quoted values honor escapes. Unquoted values end at whitespace or
   container punctuation. The scanner caps candidate keys at 128 Unicode code
   points and never retreats.

Malformed credential-shaped assignments are redacted conservatively when a
non-empty value is available. Unrelated prose is preserved.

## Structured values and errors

`redactCredentialOutput` uses the same exact key classifier. Sensitive fields
replace every string leaf, or the whole scalar when no string leaf exists,
without depending on serialization.

`redactCredentialError` creates detached inert errors. It reads own data
descriptors only, never invokes getters, `toString`, `valueOf`, or
`Symbol.toPrimitive`, and recursively sanitizes `message`, `stack`, `cause`,
`errors`, and provider data. Accessors and functions become inert placeholders.

## Bounds and verification

Tool and transcript size limits are applied after redaction. The scanner is
linear in the input size; JSON parse/walk/stringify is linear in the parsed
structure. Regression tests cover escaped JSON keys, sensitive containers,
embedded assignments, safe OAuth URLs, hostile error causes, and JSONL parsing.

