# Benchmark Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a three-pane dashboard workflow that creates, validates, atomically saves, reloads, dry-runs, and launches canonical benchmark packs.

**Architecture:** A server-only `AuthoringService` owns safe filesystem access, revision hashes, validation, rendering, and atomic writes. Thin Next.js route handlers expose typed JSON resources; a React Studio keeps a draft in client state and always shows the exact generated files before saving. Run launch continues through the existing orchestrator API.

**Tech Stack:** TypeScript 5, Node.js 20+, Next.js 16 App Router, React 19, Zod 4, YAML, CSS Modules, Testing Library, Vitest 4.

**Spec:** `docs/superpowers/specs/2026-09-04-custom-agentbench-platform-design.md`

## Global Constraints

- Files remain canonical; the UI has no independent benchmark database.
- Saving validates the complete pack and replaces files atomically.
- External edits produce a revision conflict naming changed paths; they are never silently overwritten.
- Dashboard APIs expose credential metadata only, never values.
- The left pane is Basics, Tasks, Environment, Evaluators, Agents, Review; center edits; right previews exact files; footer shows validation and snapshot state.
- Full authoring targets desktop widths; run monitoring remains usable on narrow screens.
- Preserve current scoreboard, live run, and run-detail routes.
- Read relevant local Next.js 16 documentation before modifying routes, forms, server/client component boundaries, or caching.
- UI tests make no paid calls and no writes outside temporary benchmark roots.

---

### Task 1: Atomic authoring service and round-trip renderer

**Files:**
- Create: `agentbench-live/src/core/authoring/types.ts`
- Create: `agentbench-live/src/core/authoring/render.ts`
- Create: `agentbench-live/src/core/authoring/revisions.ts`
- Create: `agentbench-live/src/core/authoring/service.ts`
- Test: `agentbench-live/tests/authoring/render.test.ts`
- Test: `agentbench-live/tests/authoring/service.test.ts`

**Interfaces:**
- Consumes: strict benchmark schemas, loader, snapshotter, and configured writable benchmark roots.
- Produces: `BenchmarkDraft`, `RenderedBenchmarkFiles`, `AuthoringRevision`, `AuthoringService.readDraft`, `preview`, `validate`, `create`, and `save`.

- [ ] **Step 1: Write failing round-trip and safety tests**

Assert load → draft → render → load semantic equality, deterministic YAML key
ordering, stable final newlines, prompt/rubric bytes in separate files, creation
only under configured writable roots, invalid ID rejection, traversal/symlink
rejection, no-op save stability, external-edit conflict with exact changed
paths, validation before mutation, and no partial files after injected rename
failure.

```ts
await expect(service.save({
  packId: "demo",
  expectedRevision: first.revision,
  draft: edited,
})).rejects.toMatchObject({
  code: "benchmark_conflict",
  changedPaths: ["tasks/task/prompt.md"],
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd agentbench-live && npm test -- tests/authoring/render.test.ts tests/authoring/service.test.ts`

Expected: FAIL because authoring modules do not exist.

- [ ] **Step 3: Define draft and result contracts**

`BenchmarkDraft` mirrors the semantic file schema but stores prompt and rubric
text inline for editing. `preview` returns sorted
`{ path, contents, language }[]`, validation diagnostics, and the computed
would-be snapshot digest. `readDraft` returns the draft plus a revision map of
semantic relative path to SHA-256.

- [ ] **Step 4: Implement deterministic rendering**

Render YAML with two-space indentation, no aliases, LF newlines, stable schema
key order, quoted ambiguous scalars, and one final newline. Preserve task and
evaluator declaration order. Render prompts/rubrics verbatim except normalize
their final newline. Immediately parse all rendered YAML through the same
schemas used by `BenchmarkLoader`.

- [ ] **Step 5: Implement conflict detection and atomic directory swap**

Serialize writes per absolute pack root using a keyed promise mutex. Recompute
the current revision under the lock and compare each path with
`expectedRevision`. Write the complete pack to a sibling
`.agentbench-write-<uuid>` directory, validate/load/snapshot it, rename the
current pack to `.agentbench-backup-<uuid>`, rename the temporary pack into
place, then remove the backup. If the second rename fails, restore the backup
before returning an error. Resolve and verify all three parent paths before any
rename or removal.

- [ ] **Step 6: Verify and commit**

Run: `cd agentbench-live && npm test -- tests/authoring tests/benchmarks && npm run typecheck`

```bash
git add agentbench-live/src/core/authoring agentbench-live/tests/authoring
git commit -m "feat(agentbench): add atomic benchmark authoring"
```

### Task 2: Benchmark, provider, and credential metadata APIs

**Files:**
- Modify: `agentbench-live/src/server/contracts.ts`
- Modify: `agentbench-live/src/server/container.ts`
- Create: `agentbench-live/src/server/authoring-contracts.ts`
- Create: `agentbench-live/src/app/api/benchmarks/route.ts`
- Create: `agentbench-live/src/app/api/benchmarks/[id]/route.ts`
- Create: `agentbench-live/src/app/api/benchmarks/preview/route.ts`
- Create: `agentbench-live/src/app/api/providers/route.ts`
- Create: `agentbench-live/src/app/api/credentials/route.ts`
- Test: `agentbench-live/tests/app/benchmark-api.test.ts`
- Test: `agentbench-live/tests/app/provider-api.test.ts`

**Interfaces:**
- Consumes: catalog, authoring service, provider registry, credential store.
- Produces: typed list/read/create/save/preview APIs plus read-only provider and credential metadata.

- [ ] **Step 1: Read required Next.js route documentation**

Read `agentbench-live/node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`, `agentbench-live/node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/dynamic-routes.md`, and `agentbench-live/node_modules/next/dist/docs/01-app/01-getting-started/08-caching.md`.

- [ ] **Step 2: Write failing route tests**

Test list/read success, strict JSON request validation, preview without writes,
create, save with revision, 409 conflict payload, 422 validation diagnostics,
404 IDs, 413 request limit, read-only-root rejection, provider capabilities,
credential configured metadata, absence of secret-shaped keys/values, and
`Cache-Control: no-store` on all local-state responses.

- [ ] **Step 3: Run tests and verify they fail**

Run: `cd agentbench-live && npm test -- tests/app/benchmark-api.test.ts tests/app/provider-api.test.ts`

Expected: FAIL because the route handlers do not exist.

- [ ] **Step 4: Extend server contracts**

Add:

```ts
export interface StudioApiPort {
  listBenchmarks(): Promise<BenchmarkSummary[]>;
  readBenchmark(id: string): Promise<ReadDraftResult>;
  previewBenchmark(draft: BenchmarkDraft): Promise<PreviewResult>;
  createBenchmark(input: CreateDraftInput): Promise<ReadDraftResult>;
  saveBenchmark(input: SaveDraftInput): Promise<ReadDraftResult>;
  listProviders(): AgentProviderDescription[];
  listCredentials(): Promise<CredentialMetadata[]>;
}
```

Create typed `StudioApiError` codes and map them to 400, 404, 409, 413, and
422. Sanitize filesystem diagnostics to pack-relative paths.

- [ ] **Step 5: Implement thin route handlers**

Parse bodies with strict Zod schemas and a 2 MiB JSON limit. Call only the
container port; do not perform filesystem work in route files. Mark GET routes
dynamic/no-store according to the installed Next.js docs. Return
`{ data }` on success and `{ error: { code, message, diagnostics? } }` on error.

- [ ] **Step 6: Verify and commit**

Run: `cd agentbench-live && npm test -- tests/app/benchmark-api.test.ts tests/app/provider-api.test.ts && npm run typecheck && npm run lint`

```bash
git add agentbench-live/src/server agentbench-live/src/app/api agentbench-live/tests/app
git commit -m "feat(agentbench): expose benchmark studio APIs"
```

### Task 3: Application shell and Studio route

**Files:**
- Modify: `agentbench-live/src/app/layout.tsx`
- Modify: `agentbench-live/src/app/globals.css`
- Create: `agentbench-live/src/components/app-shell.tsx`
- Create: `agentbench-live/src/components/app-shell.module.css`
- Create: `agentbench-live/src/app/studio/page.tsx`
- Create: `agentbench-live/src/app/studio/studio.module.css`
- Create: `agentbench-live/src/components/studio/studio-shell.tsx`
- Test: `agentbench-live/tests/app/app-shell.test.tsx`
- Test: `agentbench-live/tests/app/studio.test.tsx`

**Interfaces:**
- Consumes: benchmark list/read APIs.
- Produces: persistent top navigation and responsive three-pane Studio frame.

- [ ] **Step 1: Read required component and CSS documentation**

Read `agentbench-live/node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md` and `agentbench-live/node_modules/next/dist/docs/01-app/01-getting-started/11-css.md`.

- [ ] **Step 2: Write failing shell and layout tests**

Assert navigation links `Benchmarks`, `Studio`, `Runs`, and `Providers`; active
route semantics; one H1; keyboard-reachable controls; labelled panes; wizard
steps Basics/Tasks/Environment/Evaluators/Agents/Review; footer validation and
snapshot regions; empty/loading/error states; and no horizontal document
overflow at 1280 CSS pixels.

- [ ] **Step 3: Run tests and verify they fail**

Run: `cd agentbench-live && npm test -- tests/app/app-shell.test.tsx tests/app/studio.test.tsx`

Expected: FAIL because the app shell and Studio route do not exist.

- [ ] **Step 4: Implement app shell**

Wrap existing pages with a dark local-tool shell using semantic `nav`, `main`,
and skip link. Preserve existing page content and links. Use CSS variables for
surface, border, accent, success, warning, danger, and focus colors; maintain
WCAG AA contrast and visible `:focus-visible` outlines.

- [ ] **Step 5: Implement Studio frame**

At widths at least 1100px, use grid columns `240px minmax(480px, 1fr) 420px`.
Keep the wizard and file preview independently scrollable while the validation
footer remains visible. Below 1100px, collapse file preview behind an explicit
`Generated files` tab; below 760px show a message that full editing needs a
desktop-sized window while retaining read-only preview.

- [ ] **Step 6: Verify and commit**

Run: `cd agentbench-live && npm test -- tests/app/app-shell.test.tsx tests/app/studio.test.tsx && npm run typecheck && npm run lint`

```bash
git add agentbench-live/src/app agentbench-live/src/components agentbench-live/tests/app
git commit -m "feat(agentbench): add benchmark studio shell"
```

### Task 4: Draft state, Basics, Tasks, and Environment steps

**Files:**
- Create: `agentbench-live/src/components/studio/types.ts`
- Create: `agentbench-live/src/components/studio/use-benchmark-draft.ts`
- Create: `agentbench-live/src/components/studio/basics-step.tsx`
- Create: `agentbench-live/src/components/studio/tasks-step.tsx`
- Create: `agentbench-live/src/components/studio/environment-step.tsx`
- Create: `agentbench-live/src/components/studio/file-preview.tsx`
- Create: `agentbench-live/src/components/studio/validation-footer.tsx`
- Modify: `agentbench-live/src/components/studio/studio-shell.tsx`
- Test: `agentbench-live/tests/app/studio-authoring.test.tsx`

**Interfaces:**
- Consumes: `BenchmarkDraft`, preview API, and revision data.
- Produces: reducer actions for benchmark metadata, ordered tasks, prompts, fixtures, primitive policy, budgets, file preview, and validation diagnostics.

- [ ] **Step 1: Write failing authoring interaction tests**

Test editing ID/name/version/description/defaults; adding, duplicating,
reordering, and disabling tasks; editing prompt text; toggling browser/sandbox/
desktop independently and in combination; numeric budget validation; selection
stability after reorder; debounced preview cancellation; exact generated YAML
and prompt text; and diagnostics focusing the responsible field.

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd agentbench-live && npm test -- tests/app/studio-authoring.test.tsx`

Expected: FAIL because the draft hook and editor steps do not exist.

- [ ] **Step 3: Implement reducer-owned draft state**

Use `useReducer` with discriminated actions, immutable updates, stable client
keys separate from user-editable IDs, `dirty` state, server revision, preview
generation counter, and last saved snapshot digest. Do not mirror individual
fields into separate effects.

- [ ] **Step 4: Implement Basics and Tasks**

Use labelled native inputs, textareas, buttons, and ordered task list. IDs use
`^[a-z0-9]+(?:-[a-z0-9]+)*$`. Duplicate appends `-copy` with the first available
numeric suffix. Reordering changes declaration order only; evaluator references
continue to use stable IDs.

- [ ] **Step 5: Implement Environment and preview**

Render independent primitive checkboxes plus integer limits for browser
sessions, sandboxes, desktops, and total minutes. Require at least one allowed
primitive unless the task declares a model-only workflow. Debounce preview by
300 ms, abort stale requests, and render returned files in a selectable tree
with language-labelled read-only code blocks.

- [ ] **Step 6: Implement validation footer**

Show `Valid`, `Invalid`, `Checking`, `Unsaved`, or `Conflict`; diagnostic count;
current/would-be snapshot digest prefix; Save, Dry run, and Run actions. Disable
launch for invalid/dirty/conflicted state and announce status changes through an
`aria-live="polite"` region.

- [ ] **Step 7: Verify and commit**

Run: `cd agentbench-live && npm test -- tests/app/studio-authoring.test.tsx && npm run typecheck && npm run lint`

```bash
git add agentbench-live/src/components/studio agentbench-live/tests/app/studio-authoring.test.tsx
git commit -m "feat(agentbench): author tasks and resource policies"
```

### Task 5: Evaluators, Agents, and Review steps

**Files:**
- Create: `agentbench-live/src/components/studio/evaluators-step.tsx`
- Create: `agentbench-live/src/components/studio/evaluator-editor.tsx`
- Create: `agentbench-live/src/components/studio/agents-step.tsx`
- Create: `agentbench-live/src/components/studio/review-step.tsx`
- Create: `agentbench-live/src/components/studio/credential-status.tsx`
- Modify: `agentbench-live/src/components/studio/studio-shell.tsx`
- Test: `agentbench-live/tests/app/studio-evaluators.test.tsx`
- Test: `agentbench-live/tests/app/studio-agents.test.tsx`

**Interfaces:**
- Consumes: evaluator config schemas, provider descriptions, credential metadata, and draft reducer.
- Produces: ordered evaluator graph editing, exact 100-point allocation, agent presets, and pre-launch review.

- [ ] **Step 1: Write failing evaluator and agent interaction tests**

Test adding every evaluator type, type-specific fields, reordering,
prerequisites, cycle diagnostics, enabled weight total, model judge at 0/30/100,
network warning, provider selection, model/reasoning/options editing, credential
reference selection, configured/missing state, absence of credential values,
comparability warning, and review summary.

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd agentbench-live && npm test -- tests/app/studio-evaluators.test.tsx tests/app/studio-agents.test.tsx`

Expected: FAIL because evaluator/agent/review steps do not exist.

- [ ] **Step 3: Implement evaluator graph editor**

Render a sortable list with ID, type, enabled state, weight, prerequisites, and
type-specific config. Show a continuously updated `N / 100` meter. Disable Save
when enabled total differs from 100, a prerequisite is missing, or the graph is
cyclic. Model-judge config requires rubric text and a judge agent ID; command
config displays an unavoidable warning when network is enabled.

- [ ] **Step 4: Implement provider-backed agent editor**

Populate provider choices from `describeAll`; render only fields declared by
the provider's redacted configuration schema. Show provider, model, harness,
reasoning/sampling, tool policy, and credential reference separately. Credential
status shows only label/source/configured or missing.

- [ ] **Step 5: Implement Review**

Summarize task/agent matrix size, maximum browser/sandbox/desktop sessions,
maximum wall time, network-enabled evaluators, model judges and their total
weight, missing credentials, snapshot digest, and comparability dimensions.
Link every validation problem back to its editor step.

- [ ] **Step 6: Verify and commit**

Run: `cd agentbench-live && npm test -- tests/app/studio-evaluators.test.tsx tests/app/studio-agents.test.tsx && npm run typecheck && npm run lint`

```bash
git add agentbench-live/src/components/studio agentbench-live/tests/app
git commit -m "feat(agentbench): author evaluators and agent presets"
```

### Task 6: Save, conflict recovery, dry-run, and launch workflow

**Files:**
- Modify: `agentbench-live/src/components/studio/use-benchmark-draft.ts`
- Modify: `agentbench-live/src/components/studio/validation-footer.tsx`
- Create: `agentbench-live/src/components/studio/save-conflict.tsx`
- Create: `agentbench-live/src/components/studio/launch-review.tsx`
- Modify: `agentbench-live/src/app/api/runs/route.ts`
- Modify: `agentbench-live/src/components/run-launcher.tsx`
- Modify: `agentbench-live/src/components/live-run.tsx`
- Modify: `agentbench-live/tests/app/run-api.test.ts`
- Create: `agentbench-live/tests/app/studio-workflow.test.tsx`

**Interfaces:**
- Consumes: authoring APIs and provider-aware dry-run/run API.
- Produces: complete UI workflow from draft through immutable run and live event stream.

- [ ] **Step 1: Read required Next.js form documentation**

Read `agentbench-live/node_modules/next/dist/docs/01-app/02-guides/forms.md` and re-read the route-handler guide before changing POST behavior.

- [ ] **Step 2: Write failing workflow tests**

Test create/save success, no-op save, changed-file 409 conflict, reload that
discards local edits only after explicit action, overwrite using the newly
loaded revision only after explicit action, dry-run summary, blocked launch for
missing credentials, explicit paid-resource confirmation, run creation with
benchmark ID/digest, navigation to live run, normalized event rendering, and
cancel action.

- [ ] **Step 3: Run tests and verify they fail**

Run: `cd agentbench-live && npm test -- tests/app/studio-workflow.test.tsx tests/app/run-api.test.ts`

Expected: FAIL because Studio actions are not wired to persistence and launch.

- [ ] **Step 4: Implement save and conflict recovery**

Send draft plus expected revision. On success, replace local revision and
snapshot state with the server response and mark clean. On 409, show changed
paths and offer `Reload disk version` or `Keep my draft`; keeping the draft does
not overwrite. A separate `Overwrite after review` action first fetches the new
disk revision, shows its changed-file diff summary, then saves against that
revision.

- [ ] **Step 5: Extend run API and launch review**

Accept `{ benchmarkId, taskId, agentId, benchmarkDigest, dryRun }`. Reject a
stale digest with 409. Render dry-run capabilities, configured credentials,
planned primitives, maximum sessions/minutes, network-enabled evaluators, and
model judges. Require a checkbox labelled `I understand this run can consume
provider and Solari credits` before a non-dry launch.

- [ ] **Step 6: Render normalized live events and cancellation**

Group events by messages, local tools, Solari resources, artifacts, usage,
warnings, and errors. Show resource IDs only in run detail, not public summary.
Add `POST /api/runs/[id]/cancel`; abort provider work, mark `cancelled`, and keep
streaming cleanup events until the terminal cleanup record arrives.

- [ ] **Step 7: Verify and commit**

Run: `cd agentbench-live && npm test -- tests/app/studio-workflow.test.tsx tests/app/run-api.test.ts tests/core/orchestrator.test.ts && npm run typecheck && npm run lint`

```bash
git add agentbench-live/src/app/api agentbench-live/src/components agentbench-live/tests/app
git commit -m "feat(agentbench): launch custom benchmarks from Studio"
```

### Task 7: End-to-end security, accessibility, documentation, and release gate

**Files:**
- Create: `agentbench-live/tests/integration/studio-roundtrip.test.ts`
- Create: `agentbench-live/tests/integration/custom-benchmark-pipeline.test.ts`
- Create: `agentbench-live/tests/integration/studio-security.test.ts`
- Modify: `agentbench-live/tests/app/smoke.test.tsx`
- Modify: `agentbench-live/README.md`
- Modify: `agentbench-live/.env.example`

**Interfaces:**
- Consumes: complete Studio, provider, evaluator, and orchestrator stack.
- Produces: release-level proof and public setup/tutorial documentation.

- [ ] **Step 1: Write end-to-end fake-stack tests**

Create a benchmark through `AuthoringService`, reload it through
`BenchmarkLoader`, run it with a deterministic fake provider, invoke static and
fake-Solari evaluators, persist evidence, and assert the exact digest appears in
the run. Add a test that external prompt edits cause a UI/API conflict and a
test that secret values injected into every fake output are absent from all API
responses, SQLite text columns, manifests, and evidence blobs.

- [ ] **Step 2: Run end-to-end tests and fix only observed failures**

Run: `cd agentbench-live && npm test -- tests/integration/studio-roundtrip.test.ts tests/integration/custom-benchmark-pipeline.test.ts tests/integration/studio-security.test.ts`

Expected: PASS after integrating the completed features; any failure is fixed
with a focused regression assertion before code changes.

- [ ] **Step 3: Complete keyboard and accessibility verification**

Extend component tests to tab through navigation, wizard steps, task/evaluator
lists, editor fields, preview, diagnostics, save, dry run, and launch. Assert
labels, roles, focus restoration after dialogs, live status announcements, and
that color is not the only signal for validity or evaluator outcome.

- [ ] **Step 4: Update public documentation**

Document installation, `npm run dev`, tutorial discovery, creating a benchmark,
the full file tree and version-one YAML examples, provider setup, executable
JSONL protocol, credential references, Studio workflow, scoring semantics,
model-judge provenance, evidence retention, Solari cost confirmation, dry run,
live smoke flags, local trust model, and why secrets/private demo bindings do not
require a separate source repository.

- [ ] **Step 5: Run live smoke only when explicitly configured**

Run: `cd agentbench-live && npm run agentbench -- smoke`

Expected when `SOLARI_API_KEY` and an opted-in provider are configured: one
sandbox command, one recorded browser navigation, one desktop screenshot, and
one tutorial pipeline complete with all resources cleaned. Otherwise the command
must return a typed missing-credential preflight result without provisioning.

- [ ] **Step 6: Run the final release gate**

Run: `cd agentbench-live && npm test && npm run typecheck && npm run lint && npm run build && git diff --check`

Expected: every command PASS and `git status --short` contains only intended
source, benchmark, test, lockfile, and documentation changes.

- [ ] **Step 7: Commit release documentation and tests**

```bash
git add agentbench-live/tests agentbench-live/README.md agentbench-live/.env.example
git commit -m "docs(agentbench): document custom benchmark studio"
```
