# Evaluator Pipeline and Evidence Implementation Plan

> Historical design/plan. For shipped behavior, current budgets, verified results
> and known limitations, see the [current implementation guide](../../../agentbench-live/docs/current-state.md).
> This document preserves earlier intent; it is not a release or live certificate.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace task-specific verifier dispatch with weighted deterministic and model-judge evaluators that produce auditable, content-addressed evidence.

**Architecture:** `EvaluatorRegistry` resolves strict declarations to built-in evaluators, `EvaluatorPipeline` executes an acyclic prerequisite graph inside a run-scoped resource context, and `EvidenceStore` hashes every durable artifact. Assertion failures earn configured points; invalid benchmarks and evaluator errors prevent publication of a trustworthy primary score.

**Tech Stack:** TypeScript 5, Node.js 20+, Zod 4, JSON Schema, native fetch, Vitest 4, SHA-256, Solari browser/sandbox/desktop services.

**Spec:** `docs/superpowers/specs/2026-09-04-custom-agentbench-platform-design.md`

## Global Constraints

- Enabled evaluator weights total exactly 100.
- Preserve `passed`, `failed`, `error`, and `skipped` as distinct outcomes.
- A failed assertion may reduce points; evaluator error or invalid benchmark prevents a valid final score.
- Model judges may contribute any configured percentage, including 100, and must retain complete provenance.
- Command evaluators use a fresh Solari sandbox, no credentials, bounded resources, and network disabled unless explicitly enabled.
- Browser and HTTP assertions operate against verifier-owned targets, not agent claims.
- Every evidence payload is redacted before hashing and persistence.
- Default tests use fake Solari services and fake model transports.

---

### Task 1: Evaluator contracts, registry, graph, and scoring

**Files:**
- Create: `agentbench-live/src/core/evaluators/types.ts`
- Create: `agentbench-live/src/core/evaluators/errors.ts`
- Create: `agentbench-live/src/core/evaluators/registry.ts`
- Create: `agentbench-live/src/core/evaluators/pipeline.ts`
- Create: `agentbench-live/src/core/evidence/types.ts`
- Modify: `agentbench-live/src/core/runner/scoring.ts`
- Test: `agentbench-live/tests/evaluators/pipeline.test.ts`
- Test: `agentbench-live/tests/evaluators/scoring.test.ts`

**Interfaces:**
- Consumes: `EvaluatorDefinition`, scanned `SubmissionPackage`, `SolariServices`, provider registry, credential store, and remaining-time callbacks.
- Produces: `Evaluator`, `EvaluatorContext`, `EvaluatorResult`, `EvaluationReport`, `EvaluatorRegistry`, and `EvaluatorPipeline.run`.

- [ ] **Step 1: Write failing graph and score tests**

Test stable declaration-order execution, prerequisite skipping after failure,
continuation of independent evaluators, partial points, exact normalization to
100, duplicate IDs, missing prerequisites, cycles, evaluator throw conversion
to `error`, and `score: null` when any required evaluator errors.

```ts
expect(await pipeline.run(context, definitions)).toMatchObject({
  status: "invalid-score",
  score: null,
  possiblePoints: 100,
  results: [
    { evaluatorId: "schema", status: "error" },
    { evaluatorId: "quality", status: "skipped" },
  ],
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd agentbench-live && npm test -- tests/evaluators/pipeline.test.ts tests/evaluators/scoring.test.ts`

Expected: FAIL because the evaluator pipeline does not exist.

- [ ] **Step 3: Define normalized evaluator types**

```ts
export type EvaluatorStatus = "passed" | "failed" | "error" | "skipped";

export type EvaluatorResult = {
  evaluatorId: string;
  status: EvaluatorStatus;
  earnedPoints: number;
  possiblePoints: number;
  summary: string;
  assertions: EvaluatorAssertion[];
  evidence: EvidenceReference[];
  outputs: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type EvaluatorAssertion = {
  id: string;
  passed: boolean;
  summary: string;
  expected?: unknown;
  observed?: unknown;
};

export type EvaluationReport = {
  status: "valid-score" | "invalid-score";
  score: number | null;
  possiblePoints: 100;
  results: EvaluatorResult[];
};

export type EvidenceReference = {
  digest: string;
  size: number;
  mimeType: string;
  role: string;
  producer: "agent" | "provider" | "orchestrator" | "evaluator";
  runId: string;
  taskId: string;
  evaluatorId?: string;
  createdAt: string;
  redacted: boolean;
  external?: { url: string; expiresAt?: string };
};

export type EvidenceWriteBase = {
    mimeType: string;
    role: string;
    producer: EvidenceReference["producer"];
    evaluatorId?: string;
};

export interface EvidenceWriter {
  putBytes(input: EvidenceWriteBase & { bytes: Uint8Array }): Promise<EvidenceReference>;
  putText(input: EvidenceWriteBase & { text: string }): Promise<EvidenceReference>;
  putJson(input: EvidenceWriteBase & { value: unknown }): Promise<EvidenceReference>;
}

export interface EvaluatorResourcePort {
  acquireSandbox(label: string, options?: { timeoutMs?: number }): Promise<SandboxHandle>;
  acquireBrowser(label: string, options?: { recording?: boolean }): Promise<BrowserHandle>;
  acquireDesktop(label: string, options?: { timeoutMs?: number }): Promise<DesktopHandle>;
  publishOutputs(evaluatorId: string, outputs: Record<string, unknown>): void;
  getOutput(evaluatorId: string, key: string): unknown;
  dispose(): Promise<void>;
}

export type EvaluatorContext = {
  runId: string;
  taskId: string;
  submission: SubmissionPackage;
  snapshot: BenchmarkSnapshot;
  evidence: EvidenceWriter;
  resources: EvaluatorResourcePort;
  providers: AgentProviderRegistry;
  credentials: CredentialStore;
  remainingMs(): number;
};

export interface Evaluator {
  readonly type: EvaluatorDefinition["type"];
  validate(definition: EvaluatorDefinition): void;
  evaluate(
    definition: EvaluatorDefinition,
    context: EvaluatorContext,
    signal: AbortSignal,
  ): Promise<Omit<EvaluatorResult, "evaluatorId" | "possiblePoints">>;
}
```

- [ ] **Step 4: Implement registry and graph validation**

Reject duplicate evaluator types at registration and unknown types at pack
load. Topologically validate prerequisites but retain declaration order among
currently runnable nodes. A prerequisite with `failed`, `error`, or `skipped`
causes a dependent evaluator to return `skipped` with zero points and metadata
`{ reason: "prerequisite", prerequisite: id }`.

- [ ] **Step 5: Implement scoring semantics**

Scale an evaluator's internal earned fraction by its configured weight. Round
only the displayed total to two decimals; persist unrounded fractions. Return
`status: "invalid-score"` and `score: null` if any enabled evaluator reports
`error`, if possible points differ from 100, or if a result is missing. Failed
and prerequisite-skipped evaluators remain valid zero/partial outcomes.

- [ ] **Step 6: Verify and commit**

Run: `cd agentbench-live && npm test -- tests/evaluators/pipeline.test.ts tests/evaluators/scoring.test.ts && npm run typecheck`

```bash
git add agentbench-live/src/core/evaluators agentbench-live/src/core/runner/scoring.ts agentbench-live/tests/evaluators
git commit -m "feat(agentbench): add weighted evaluator pipeline"
```

### Task 2: Content-addressed evidence store

**Files:**
- Create: `agentbench-live/src/core/evidence/store.ts`
- Create: `agentbench-live/src/core/evidence/manifest.ts`
- Test: `agentbench-live/tests/evidence/store.test.ts`
- Modify: `agentbench-live/.gitignore`

**Interfaces:**
- Consumes: credential-aware redaction and run/snapshot identity.
- Produces: `EvidenceStore.putBytes`, `putJson`, `putText`, `get`, and immutable `EvidenceReference`/manifest types.

- [ ] **Step 1: Write failing evidence tests**

Assert identical redacted bytes deduplicate, different bytes produce different
digests, manifests contain role/producer/associations/MIME/size/redaction state,
unsafe logical names are rejected, writes are atomic, secret values are absent
from both blob and manifest, and a missing external replay URL does not remove
durable local evidence.

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd agentbench-live && npm test -- tests/evidence/store.test.ts`

Expected: FAIL because the evidence store does not exist.

- [ ] **Step 3: Implement immutable storage**

Store blobs under `.agentbench/evidence/sha256/<first-two>/<digest>` and JSON
manifests under `.agentbench/evidence/manifests/<run-id>.json`. Redact before
hashing. Write a temporary sibling file using exclusive create, fsync it, then
rename atomically. When a blob exists, verify its size and digest before reuse.

- [ ] **Step 4: Implement references and manifests**

```ts
export type EvidenceReference = {
  digest: string;
  size: number;
  mimeType: string;
  role: string;
  producer: "agent" | "provider" | "orchestrator" | "evaluator";
  runId: string;
  taskId: string;
  evaluatorId?: string;
  createdAt: string;
  redacted: boolean;
  external?: { url: string; expiresAt?: string };
};
```

Sort manifest entries by digest then role. External references supplement but
never replace a local digest for screenshots, assertions, logs, or result data.

- [ ] **Step 5: Verify and commit**

Run: `cd agentbench-live && npm test -- tests/evidence tests/credentials/redaction.test.ts && npm run typecheck`

```bash
git add agentbench-live/src/core/evidence agentbench-live/tests/evidence agentbench-live/.gitignore
git commit -m "feat(agentbench): store content-addressed evidence"
```

### Task 3: File, schema, and numeric evaluators

**Files:**
- Create: `agentbench-live/src/core/evaluators/file.ts`
- Create: `agentbench-live/src/core/evaluators/json-schema.ts`
- Create: `agentbench-live/src/core/evaluators/schema.ts`
- Create: `agentbench-live/src/core/evaluators/numeric.ts`
- Test: `agentbench-live/tests/evaluators/file.test.ts`
- Test: `agentbench-live/tests/evaluators/schema.test.ts`
- Test: `agentbench-live/tests/evaluators/numeric.test.ts`

**Interfaces:**
- Consumes: read-only scanned submission and snapshot asset readers.
- Produces: built-ins `file`, `schema`, and `numeric`.

- [ ] **Step 1: Write failing contract tests**

File tests cover presence, absence, byte size, SHA-256, UTF-8 substring/regex,
missing paths, and no traversal. Schema tests cover JSON and YAML parsing,
required/additional properties, local `$ref`, malformed schemas, and no remote
references. Numeric tests cover exact values, absolute/relative tolerance,
NaN/infinity rejection, arrays, sample statistics, seeded repeated-run equality,
and useful expected/observed assertions.

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd agentbench-live && npm test -- tests/evaluators/file.test.ts tests/evaluators/schema.test.ts tests/evaluators/numeric.test.ts`

Expected: FAIL because the evaluator implementations do not exist.

- [ ] **Step 3: Implement the file evaluator**

Validate config as `{ subject, assertion, value?, flags? }`. Read only packaged
submission entries, cap decoded text at 1 MiB, compile regex with permitted
flags `i`, `m`, `s`, and emit one assertion plus optional text evidence without
including unrelated file contents.

- [ ] **Step 4: Implement the schema evaluator**

Run `cd agentbench-live && npm install ajv`, instantiate `Ajv2020` in strict
mode, and commit the resolved version in `package-lock.json`. Permit `$ref` only
to files already inside the immutable benchmark snapshot; reject HTTP(S) and
absolute references before compilation. Parse JSON/YAML subject files and emit
one assertion per validation diagnostic with JSON Pointer paths.

- [ ] **Step 5: Implement the numeric evaluator**

Validate config operands as explicit JSON Pointer references into subject JSON
or evaluator outputs. Implement `exact`, `absolute-tolerance`,
`relative-tolerance`, `mean`, `sample-variance`, `pearson-correlation`,
`ellipse-rmse`, and `reproducible-equality`. Implement `ellipse-rmse` by moving
the pure target-distance calculation from `src/core/verifiers/geometry.ts` into
`numeric.ts` without changing its formula. Reject non-finite inputs as evaluator
errors; a finite value outside tolerance is a failed assertion.

- [ ] **Step 6: Verify and commit**

Run: `cd agentbench-live && npm test -- tests/evaluators/file.test.ts tests/evaluators/schema.test.ts tests/evaluators/numeric.test.ts && npm run typecheck`

```bash
git add agentbench-live/package.json agentbench-live/package-lock.json agentbench-live/src/core/evaluators agentbench-live/tests/evaluators
git commit -m "feat(agentbench): add static artifact evaluators"
```

### Task 4: Isolated command evaluator and run-scoped resources

**Files:**
- Create: `agentbench-live/src/core/evaluators/runtime.ts`
- Create: `agentbench-live/src/core/evaluators/command.ts`
- Modify: `agentbench-live/src/core/solari/contracts.ts`
- Modify: `agentbench-live/src/core/solari/clients.ts`
- Modify: `agentbench-live/src/core/solari/upload-tree.ts`
- Test: `agentbench-live/tests/evaluators/command.test.ts`
- Test: `agentbench-live/tests/evaluators/runtime.test.ts`

**Interfaces:**
- Consumes: Solari sandbox service, immutable benchmark snapshot, submission package, evidence store, and resource supervisor.
- Produces: built-in `command`, `EvaluatorRuntime`, named evaluator outputs, and resource leases retained until pipeline cleanup.

- [ ] **Step 1: Write failing isolation and command tests**

Assert one fresh sandbox per command evaluator, snapshot mounted/read as
`/benchmark`, submission as `/submission`, output at `/result`, no credential
environment, direct argv execution, timeout/output limits, nonzero exit as a
failed assertion, infrastructure failure as `error`, network denied by default,
explicit network enablement recorded in metadata, and cleanup after all exit
paths. Test `publishPort` returns a preview URL kept alive for dependents.

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd agentbench-live && npm test -- tests/evaluators/command.test.ts tests/evaluators/runtime.test.ts`

Expected: FAIL because evaluator runtime and command evaluator do not exist.

- [ ] **Step 3: Implement evaluator runtime resource scope**

`EvaluatorRuntime` owns acquired browser/sandbox/desktop handles and named
outputs until the complete pipeline finishes. Its `dispose()` uses
`ResourceSupervisor.cleanup()` exactly once. `getOutput(evaluatorId, key)` only
reads outputs from completed prerequisite evaluators.

- [ ] **Step 4: Implement no-network command execution**

For `network: false` or omitted, invoke the submitted command through
`unshare --user --map-root-user --net --mount-proc -- <argv>` inside the clean
Linux sandbox. First run `unshare --user --map-root-user --net -- true`; if the
platform cannot enforce isolation, return evaluator `error` and do not run the
submission. For `network: true`, execute argv directly and record
`networkEnabled: true` in metadata and preflight.

- [ ] **Step 5: Implement command result protocol**

The command receives `AGENTBENCH_RESULT=/result/evaluator-result.json` and no
other AgentBench or credential variables. If that file exists, parse
`{ assertions, outputs, evidence }` with strict Zod validation. Otherwise map
exit code zero to one passed assertion and nonzero to one failed assertion.
Capture bounded stdout/stderr as redacted evidence.

- [ ] **Step 6: Implement background preview support**

When config includes `background: true` and `publishPort: 3000`, start the
process, wait for a bounded `healthPath` HTTP success through the preview URL,
and expose output key `previewUrl`. Retain the process and sandbox lease until
pipeline cleanup so dependent HTTP/browser evaluators can use it.

- [ ] **Step 7: Verify and commit**

Run: `cd agentbench-live && npm test -- tests/evaluators/command.test.ts tests/evaluators/runtime.test.ts tests/core/solari-clients.test.ts && npm run typecheck`

```bash
git add agentbench-live/src/core/evaluators agentbench-live/src/core/solari agentbench-live/tests/evaluators agentbench-live/tests/core/solari-clients.test.ts
git commit -m "feat(agentbench): add isolated command evaluator"
```

### Task 5: HTTP and recorded browser evaluators

**Files:**
- Create: `agentbench-live/src/core/evaluators/value-reference.ts`
- Create: `agentbench-live/src/core/evaluators/http.ts`
- Create: `agentbench-live/src/core/evaluators/browser.ts`
- Test: `agentbench-live/tests/evaluators/http.test.ts`
- Test: `agentbench-live/tests/evaluators/browser.test.ts`

**Interfaces:**
- Consumes: evaluator prerequisite outputs, Solari browser service, evidence store, and runtime scope.
- Produces: built-ins `http` and `browser` plus strict `${evaluatorId.outputs.key}` resolution.

- [ ] **Step 1: Write failing reference, HTTP, and browser tests**

Test exact output reference resolution and rejection of arbitrary interpolation.
HTTP tests cover method, headers without credentials, request body, status,
header, JSON Pointer, text assertions, redirect behavior, timeout, response
size, and network failure classification. Browser tests cover recorded session
creation, goto/fill/click/text/URL assertions, screenshots, replay reference,
selector/action failure, timeout, and cleanup.

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd agentbench-live && npm test -- tests/evaluators/http.test.ts tests/evaluators/browser.test.ts`

Expected: FAIL because HTTP/browser evaluators do not exist.

- [ ] **Step 3: Implement value references and HTTP evaluator**

Allow a config scalar to be either a literal or exactly
`{ fromEvaluator: "serve", output: "previewUrl" }`; do not implement string
templating. Use native fetch with redirect policy from config, an abort timeout,
10 MiB response cap, and an explicit safe header allow-list that rejects
`authorization`, `cookie`, and `proxy-authorization` unless a later dedicated
credential design authorizes them.

- [ ] **Step 4: Implement browser action DSL**

Validate actions as a discriminated union of `goto`, `fill`, `click`,
`assertText`, `assertUrl`, and `screenshot`. Launch `recording: true`, execute
sequentially, emit an assertion for every assert action, store screenshots as
PNG evidence, capture the replay URL as expiring external metadata, and close
the browser through the runtime resource scope.

- [ ] **Step 5: Verify and commit**

Run: `cd agentbench-live && npm test -- tests/evaluators/http.test.ts tests/evaluators/browser.test.ts && npm run typecheck`

```bash
git add agentbench-live/src/core/evaluators agentbench-live/tests/evaluators
git commit -m "feat(agentbench): add HTTP and browser evaluators"
```

### Task 6: Model-judge evaluator

**Files:**
- Create: `agentbench-live/src/core/evaluators/model-judge.ts`
- Create: `agentbench-live/src/core/evaluators/judge-schema.ts`
- Test: `agentbench-live/tests/evaluators/model-judge.test.ts`

**Interfaces:**
- Consumes: provider registry, credential store, immutable rubric, declared submission inputs, evidence store.
- Produces: built-in `model-judge` and complete `JudgeMetadata`.

- [ ] **Step 1: Write failing judge tests**

Test 0%, 30%, and 100% configured weights; rubric and prompt digests; exact
declared input selection; provider/model/sampling identity; strict structured
score output; one syntax repair attempt; no repair for a valid low score;
provider failure as evaluator error; redacted raw response evidence; and no
tools or Solari resources made available to the judge.

- [ ] **Step 2: Run test and verify it fails**

Run: `cd agentbench-live && npm test -- tests/evaluators/model-judge.test.ts`

Expected: FAIL because the model-judge evaluator does not exist.

- [ ] **Step 3: Define judge output schema**

```ts
export const JudgeOutputSchema = z.object({
  score: z.number().min(0).max(1),
  summary: z.string().min(1).max(4_000),
  criteria: z.array(z.object({
    id: z.string().min(1),
    score: z.number().min(0).max(1),
    rationale: z.string().min(1).max(2_000),
  }).strict()).max(100),
}).strict();
```

- [ ] **Step 4: Implement judge execution and repair**

Build one deterministic prompt containing rubric bytes, declared submission
files, benchmark/task IDs, and the output schema. Invoke the judge provider's
structured-completion capability with no tools. If JSON parsing/schema
validation fails, send one repair request containing validation diagnostics and
the original response. A second invalid response returns `error`.

- [ ] **Step 5: Persist full judge provenance as evidence**

Record provider, resolved model, sampling settings, rubric digest, prompt
digest, selected input digests, raw redacted responses, parsed result, usage,
and retry count. Convert `score` to the evaluator's earned fraction without a
hard cap on configured weight.

- [ ] **Step 6: Verify and commit**

Run: `cd agentbench-live && npm test -- tests/evaluators/model-judge.test.ts tests/evaluators/scoring.test.ts && npm run typecheck`

```bash
git add agentbench-live/src/core/evaluators agentbench-live/tests/evaluators
git commit -m "feat(agentbench): add model judge evaluator"
```

### Task 7: Migrate tutorial verifiers to evaluator declarations

**Files:**
- Create: `agentbench-live/benchmarks/tutorials/agentbench-live/tasks/url-shortener/evaluators/verify-app.mjs`
- Create: `agentbench-live/benchmarks/tutorials/agentbench-live/tasks/url-shortener/evaluators/results.schema.json`
- Create: `agentbench-live/benchmarks/tutorials/agentbench-live/tasks/same-stats-different-graph/evaluators/reproduce.py`
- Create: `agentbench-live/benchmarks/tutorials/agentbench-live/tasks/same-stats-different-graph/evaluators/results.schema.json`
- Modify: both tutorial `task.yaml` files
- Modify: `agentbench-live/src/core/verifiers/url-shortener.ts`
- Modify: `agentbench-live/src/core/verifiers/same-stats.ts`
- Modify: `agentbench-live/src/core/verifiers/registry.ts`
- Modify: `agentbench-live/tests/verifiers/url-shortener.test.ts`
- Modify: `agentbench-live/tests/verifiers/same-stats.test.ts`
- Create: `agentbench-live/tests/evaluators/tutorial-regression.test.ts`

**Interfaces:**
- Consumes: all built-in evaluators and current verifier fixtures/geometry helpers.
- Produces: tutorial task evaluator graphs with the same 100-point totals and known pass/fail outcomes.

- [ ] **Step 1: Freeze current tutorial regression outcomes**

Before editing verifiers, encode the current observable contract in
`tutorial-regression.test.ts`: URL Shortener passing has `core: 45`, wrong
redirect has `core: 0`, and a nonzero build exits with `build_failed`; Same
Stats passing has `total: 100`, while a byte-different rerun has
`reproducible: false` and `total: 0`. Also freeze the current stage order and
resource cleanup counts from the two verifier tests.

- [ ] **Step 2: Run the new regression test and verify it fails**

Run: `cd agentbench-live && npm test -- tests/evaluators/tutorial-regression.test.ts`

Expected: FAIL because task YAML still uses `legacyVerifier` and no evaluator
pipeline is composed.

- [ ] **Step 3: Express URL Shortener verification as evaluators**

Use schema/file checks for the submission contract, a network-enabled
background command evaluator to install/build/start in a clean sandbox, and a
dependent recorded browser evaluator for selectors, shortening, redirect, and
screenshot. Preserve current point categories and assertion IDs in evaluator
metadata.

- [ ] **Step 4: Express Same Stats verification as evaluators**

Use schema/file checks, a no-network command evaluator that runs the exact
seeded CLI, numeric evaluators for sample means/variances/correlation/shape
error/reproducibility, and file checks for methodology headings and comparison
plot. Use the `ellipse-rmse` numeric operation from Task 3 with the current
target and tolerance.

- [ ] **Step 5: Remove legacy verifier dispatch**

Once regression tests pass, remove `legacyVerifier` from schemas and tutorial
files, delete `VerifierRegistry`, and retain reusable pure geometry helpers only
where imported by generic numeric evaluation or tests. Confirm no legacy
dispatch remains:

Run: `cd agentbench-live && rg -n "legacyVerifier|VerifierRegistry|UrlShortenerVerifier|SameStatsVerifier" src benchmarks tests`

Expected: no matches.

- [ ] **Step 6: Verify and commit**

Run: `cd agentbench-live && npm test -- tests/evaluators/tutorial-regression.test.ts tests/verifiers tests/evaluators && npm run typecheck`

```bash
git add agentbench-live/benchmarks agentbench-live/src/core/verifiers agentbench-live/src/core/evaluators agentbench-live/tests
git commit -m "feat(agentbench): migrate tutorials to evaluator pipeline"
```

### Task 8: Integrate evaluation reports, persistence, and run details

**Files:**
- Modify: `agentbench-live/src/core/runner/contracts.ts`
- Modify: `agentbench-live/src/core/runner/orchestrator.ts`
- Modify: `agentbench-live/src/core/domain/run.ts`
- Modify: `agentbench-live/src/core/persistence/schema.sql`
- Modify: `agentbench-live/src/core/persistence/migrations.ts`
- Modify: `agentbench-live/src/core/persistence/sqlite-repository.ts`
- Modify: `agentbench-live/src/server/container.ts`
- Modify: `agentbench-live/src/cli.ts`
- Modify: `agentbench-live/src/components/evidence-panel.tsx`
- Modify: `agentbench-live/src/app/runs/[id]/page.tsx`
- Modify: `agentbench-live/tests/core/orchestrator.test.ts`
- Modify: `agentbench-live/tests/app/run-detail.test.tsx`
- Modify: `agentbench-live/tests/integration/pipeline.test.ts`

**Interfaces:**
- Consumes: evaluator registry/pipeline and evidence store.
- Produces: persisted `EvaluationReport`, evidence manifest, valid/invalid score state, and detailed assertion/judge presentation.

- [ ] **Step 1: Read the required Next.js documentation**

Read `agentbench-live/node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md` and `agentbench-live/node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/dynamic-routes.md` before changing the run detail page.

- [ ] **Step 2: Write failing orchestration and UI tests**

Assert orchestrator calls the evaluator pipeline after packaging, stores
`evaluationStatus`, nullable primary score, evaluator results, and evidence
manifest, and always disposes evaluator resources. Render tests must distinguish
failed assertions, evaluator errors, skipped prerequisites, deterministic versus
judged points, and show judge provenance without raw secrets.

- [ ] **Step 3: Run tests and verify they fail**

Run: `cd agentbench-live && npm test -- tests/core/orchestrator.test.ts tests/app/run-detail.test.tsx tests/integration/pipeline.test.ts`

Expected: FAIL because the runner still expects one legacy verification result.

- [ ] **Step 4: Replace verifier port with evaluator pipeline**

Change orchestration to call `EvaluatorPipeline.run` with the snapshotted task
definitions, submission, provider registry, credential store, Solari services,
evidence store, deadlines, and resource supervisor. Transition through
`evaluating` and `capturing`; classify invalid reports as `evaluator_error` or
`score_invalid` without setting a numeric score.

- [ ] **Step 5: Persist normalized evaluation records**

Add migration 4 tables `evaluator_results`, `evaluator_assertions`, and
`evidence_references` keyed to runs with foreign keys and stable declaration
order. Store metadata as redacted JSON. Repository writes the terminal run,
results, assertions, and evidence manifest in one immediate transaction.

- [ ] **Step 6: Update run details**

Render a score summary, evaluator cards, assertion expected/observed values,
evidence links/previews, and a model-judge badge with provider/model/rubric/prompt
digests and retry count. Keep failed runs clickable and preserve historical
legacy `score`/`evidence` JSON rendering.

- [ ] **Step 7: Run the complete phase gate**

Run: `cd agentbench-live && npm test && npm run typecheck && npm run lint && npm run build`

Expected: every command PASS; no paid services are contacted.

- [ ] **Step 8: Commit evaluator integration**

```bash
git add agentbench-live/src agentbench-live/tests agentbench-live/benchmarks
git commit -m "feat(agentbench): persist evaluator results and evidence"
```
