# Structured Redaction Pipeline Implementation Plan

> Historical design/plan. For shipped behavior, current budgets, verified results
> and known limitations, see the [current implementation guide](../../../agentbench-live/docs/current-state.md).
> This document preserves earlier intent; it is not a release or live certificate.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mixed-grammar credential lexer with a JSON-aware, URL-aware redaction pipeline that cannot corrupt transcripts or leak escaped credentials.

**Architecture:** Exact semantic key matching is shared by structured-output, JSON, URL-query, and free-text redaction. Whole JSON documents are parsed and recursively sanitized before serialization; non-JSON text shields URL spans before assignment scanning. Detached errors continue to be copied through inert own-data descriptors only.

**Tech Stack:** TypeScript 5, Node.js URL/JSON APIs, Vitest 4.

**Spec:** `docs/superpowers/specs/2026-09-04-structured-redaction-pipeline-design.md`

## Global Constraints

- Keep `redact(value: string, context?: RedactionContext): string` compatible.
- Match credential keys by exact canonical value, never by substring.
- Preserve valid JSON and safe token-usage telemetry.
- Never invoke user-defined accessors or coercion hooks while sanitizing errors.
- Apply output bounds after redaction and use no paid services in tests.

---

### Task 1: Semantic key classifier and structured JSON redaction

**Files:**
- Create: `agentbench-live/src/core/security/redaction-keys.ts`
- Modify: `agentbench-live/src/core/security/redact.ts`
- Modify: `agentbench-live/src/core/credentials/redaction.ts`
- Test: `agentbench-live/tests/core/security.test.ts`
- Test: `agentbench-live/tests/credentials/redaction.test.ts`

**Interfaces:**
- Produces: `canonicalizeCredentialKey(key: string): string` and `isCredentialShapedKey(key: string): boolean`.
- Preserves: `redact` and credential redaction public APIs.

- [ ] **Step 1: Write failing structured JSON tests**

Add tests asserting:

```ts
const output = redact('{"t\\u006fken":{"nested":"secret"},"api\\u005fkey":["secret"],"token_details":{"cached":2},"input_tokens":20,"ordinary":"token=embedded"}');
expect(JSON.parse(output)).toEqual({
  token: "[REDACTED]",
  api_key: "[REDACTED]",
  token_details: { cached: 2 },
  input_tokens: 20,
  ordinary: "token=[REDACTED]",
});
```

Also assert that `tokens`, `token_count`, and `max_tokens` remain typed, while
nested `access_token`, `password`, and `client_secret` fields redact complete
scalar or container values.

- [ ] **Step 2: Verify RED**

Run: `pnpm --config.lockfile=false test -- tests/core/security.test.ts tests/credentials/redaction.test.ts`

Expected: FAIL because escaped keys leak, containers are corrupted, or usage
keys are classified as credentials.

- [ ] **Step 3: Implement exact key classification and the JSON branch**

Create a frozen canonical-key set. In `redact`, attempt `JSON.parse` only for a
complete input and recursively produce a fresh value. Replace any exact
sensitive field value with `"[REDACTED]"`; recursively visit safe containers
and pass string leaves through the non-JSON sanitizer. Serialize with
`JSON.stringify`.

Update `redactCredentialOutput` and `redactCredentialError` to import the same
classifier so all publishing paths share one policy.

- [ ] **Step 4: Verify GREEN and commit**

Run: `pnpm --config.lockfile=false test -- tests/core/security.test.ts tests/credentials/redaction.test.ts`

```bash
git add agentbench-live/src/core/security agentbench-live/src/core/credentials/redaction.ts agentbench-live/tests/core/security.test.ts agentbench-live/tests/credentials/redaction.test.ts
git commit -m "fix(agentbench): sanitize structured credential data"
```

### Task 2: URL shielding and bounded free-text assignments

**Files:**
- Modify: `agentbench-live/src/core/security/redact.ts`
- Test: `agentbench-live/tests/core/security.test.ts`

**Interfaces:**
- Consumes: `isCredentialShapedKey` from Task 1.
- Produces: deterministic free-text redaction with URL spans excluded from assignment parsing.

- [ ] **Step 1: Write failing URL and quoted-assignment tests**

Add separate tests for:

```ts
expect(redact("endpoint=https://example.test/oauth/token?mode=view")).toBe(
  "endpoint=https://example.test/oauth/token?mode=view",
);
expect(redact("callback=https://example.test/cb?api_key=secret")).toBe(
  "callback=[REDACTED_SIGNED_URL]",
);
expect(redact(String.raw`note="token=abc\\\"def"`)).toBe(
  String.raw`note="token=[REDACTED]"`,
);
```

Cover ordinary URLs beside credential assignments, JSON-style escaped quoted
keys in prose, existing placeholders, Unicode keys at the 128-code-point cap,
and punctuation/container boundaries.

- [ ] **Step 2: Verify RED**

Run: `pnpm --config.lockfile=false test -- tests/core/security.test.ts`

Expected: FAIL because the current lexer consumes the OAuth URL path or mishandles escaped values.

- [ ] **Step 3: Implement span shielding and the non-retreating scanner**

Collect URL ranges with their replacement, copy non-URL slices through the
assignment scanner, and append shielded URLs untouched or replaced. Decode a
quoted candidate key only for comparison. Count its length with Unicode code
points. Preserve delimiters and quote characters while replacing only value
contents with `[REDACTED]`.

- [ ] **Step 4: Verify GREEN and commit**

Run: `pnpm --config.lockfile=false test -- tests/core/security.test.ts`

```bash
git add agentbench-live/src/core/security/redact.ts agentbench-live/tests/core/security.test.ts
git commit -m "fix(agentbench): shield URLs during text redaction"
```

### Task 3: Transcript, broker, and inert-error regression gate

**Files:**
- Modify: `agentbench-live/tests/core/codex-adapter.test.ts`
- Modify: `agentbench-live/tests/tools/broker.test.ts`
- Modify: `agentbench-live/tests/tools/solari-tools.test.ts`
- Modify: `agentbench-live/tests/credentials/redaction.test.ts`

**Interfaces:**
- Consumes: the redaction APIs from Tasks 1 and 2.
- Produces: end-to-end evidence that sanitized JSONL stays parseable and bounded tool/error output cannot leak.

- [ ] **Step 1: Write failing integration regressions**

Add a JSONL event containing escaped sensitive keys, sensitive arrays, an
ordinary string with an embedded assignment, and a safe OAuth URL; assert one
event is returned with valid structure. Add detached `cause`/`AggregateError`
data containing the same shapes. Extend broker and Solari fixtures so size
checks happen after the new placeholders are emitted.

- [ ] **Step 2: Verify focused regressions**

Run: `pnpm --config.lockfile=false test -- tests/core/codex-adapter.test.ts tests/tools/broker.test.ts tests/tools/solari-tools.test.ts tests/credentials/redaction.test.ts`

Expected: PASS after Tasks 1 and 2; if a regression fails, add the smallest
unit-level reproducer first, verify it fails, then fix the production branch.

- [ ] **Step 3: Run the complete quality gate**

Run:

```bash
pnpm --config.lockfile=false test
pnpm --config.lockfile=false typecheck
pnpm --config.lockfile=false lint
pnpm --config.lockfile=false build
```

Expected: all commands exit 0 with no credential text in output.

- [ ] **Step 4: Commit the integration gate**

```bash
git add agentbench-live/tests
git commit -m "test(agentbench): cover structured redaction end to end"
```

