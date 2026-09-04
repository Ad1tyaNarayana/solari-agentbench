# Custom AgentBench Platform Design

**Status:** Approved design

**Date:** 2026-09-04

**Supersedes:** The fixed task and agent configuration portions of
`2026-09-01-agentbench-live-design.md`. The original document remains the
design record for the shipped AgentBench Live baseline.

## Summary

AgentBench Live will evolve from a fixed demonstration matrix into a
local-first, bring-your-own-credentials platform for authoring and running
custom agent benchmarks. Users can define benchmark tasks and evaluators as
version-controlled files, configure multiple agent runtimes or model APIs, and
observe each run through the existing live dashboard. The two current tasks
remain included as transparent tutorials and regression baselines.

The platform preserves AgentBench Live's core value: agents may choose the
Solari browser, sandbox, desktop, or any allowed combination, while independent
evaluators grade their submitted artifacts in fresh infrastructure and retain
the evidence behind every score.

This is an in-place evolution of the existing TypeScript application. The
current orchestrator, lifecycle supervision, SQLite persistence, local queue,
cleanup, and SSE event streaming remain. Hardcoded task, agent, and verifier
registries become file-backed benchmark loading plus provider and evaluator
registries.

## Goals

- Let users create complete benchmarks without changing AgentBench source.
- Make benchmark folders canonical, reviewable, portable, and suitable for a
  public Git repository.
- Offer a dashboard wizard that edits the same canonical files rather than
  maintaining a second configuration database.
- Run local Codex, full third-party agent harnesses, and raw model APIs behind
  one lifecycle contract.
- Keep model identity separate from harness identity so results remain
  interpretable.
- Let an agent decide which allowed Solari primitives a task needs.
- Support deterministic evaluators and weighted model judges in one scoring
  pipeline.
- Preserve complete, content-addressed evidence and the exact benchmark
  snapshot for every run.
- Keep credentials out of public files, snapshots, logs, events, and SQLite.
- Retain the current tutorial tasks as runnable examples and score-regression
  fixtures.

## Non-goals for Version One

- A hosted, multi-tenant benchmark service.
- Team collaboration, permissions, or remote credential custody.
- A remote benchmark or provider marketplace.
- Arbitrary runtime plugin installation from the dashboard.
- Distributed queues or worker fleets.
- Treating scores from materially different harnesses as automatically
  interchangeable.
- Protecting evaluator logic as a secret. Reproducibility is preferred over
  hidden tests in the public project.

## Product Principles

### Files are canonical

Benchmark behavior is defined by files under a benchmark root. The dashboard
is an authoring interface for those files. It does not keep a competing copy of
task configuration in SQLite. A benchmark can be created in the UI, edited in
an editor, reviewed in Git, copied to another machine, and loaded again without
semantic loss.

### Every run is immutable

Starting a run creates a validated, immutable snapshot of the benchmark files
and assigns it a SHA-256 content digest. The run always refers to that digest,
even if the author edits the benchmark while the run is active. Historical
scores therefore remain attributable to the exact prompts, fixtures, policies,
agent definitions, evaluators, and rubrics that produced them.

### Agent execution and evaluation are separate

The selected agent works in its own disposable workspace. Evaluators consume a
scanned submission package and run in new resources. Agent claims, transcripts,
and self-reported test results never determine deterministic evaluator results.

### Solari use is policy-bounded discretion

Each task declares which of `browser`, `sandbox`, and `desktop` are allowed,
plus per-primitive and total budgets. The provider plans its resource use before
billable execution. It may select any justified allowed combination. Evaluators
may independently provision the clean resources required to verify the result.

## High-Level Architecture

```text
Benchmark files <----> AuthoringService <----> Studio UI
       |
       v
BenchmarkLoader ---> immutable snapshot ---> AgentBenchOrchestrator
                                                |
                      +-------------------------+------------------------+
                      |                         |                        |
                      v                         v                        v
               AgentProvider             CredentialStore        EvaluatorRegistry
                      |                                                  |
          +-----------+-----------+                         +------------+----------+
          |           |           |                         |                       |
     local agent   agent CLI   raw model API          deterministic            model judge
          |           |           |                    evaluators              evaluators
          +-----------+-----------+                         +------------+----------+
                      |                                                  |
                      +---------- Solari browser/sandbox/desktop --------+
                                                |
                                                v
                                      SQLite + evidence store + SSE
```

The new components are:

1. **BenchmarkLoader** discovers folders, parses YAML, validates schemas,
   resolves safe relative paths, and creates immutable snapshots.
2. **AuthoringService** provides atomic create/update operations for the
   dashboard and returns validation diagnostics plus generated-file previews.
3. **AgentProviderRegistry** resolves an agent definition to a provider that
   implements the common planning and execution lifecycle.
4. **EvaluatorRegistry** resolves evaluator declarations, runs them in order,
   normalizes outcomes, and calculates the weighted score.
5. **CredentialStore** resolves named secrets from local sources without
   exposing their values to benchmark files or persistence.

The existing `AgentBenchOrchestrator` remains the owner of deadlines, queueing,
cancellation, state transitions, cleanup, persistence, and event publication.

## Benchmark Pack Format

The conventional structure is:

```text
benchmarks/
  tutorials/
    agentbench-live/
      benchmark.yaml
      agents.yaml
      tasks/
        url-shortener/
          task.yaml
          prompt.md
          fixtures/
          evaluators/
          rubrics/
        same-stats-different-graphs/
          task.yaml
          prompt.md
          fixtures/
          evaluators/
          rubrics/
  my-benchmark/
    benchmark.yaml
    agents.yaml
    tasks/
      my-task/
        task.yaml
        prompt.md
        fixtures/
        evaluators/
        rubrics/
```

Only `benchmark.yaml`, `agents.yaml`, each `task.yaml`, and each referenced
prompt or evaluator asset are semantic inputs. The conventional directories
make packs easy to navigate but do not grant files implicit authority.

All schemas carry an explicit `schemaVersion`. Unknown fields fail validation
by default so typos cannot silently change a benchmark. Future migrations are
explicit and produce a reviewable file diff.

### `benchmark.yaml`

```yaml
schemaVersion: 1
id: research-replication
name: Research Replication Bench
version: 1.0.0
description: Reproduce computational findings with auditable evidence.
taskRoots:
  - tasks
defaults:
  timeoutSeconds: 1800
  maxConcurrency: 1
  submissionDirectory: submission
```

The benchmark `id` is stable identity. `version` is author-managed display
metadata; the snapshot digest remains the authoritative content identity.

### `agents.yaml`

```yaml
schemaVersion: 1
agents:
  - id: codex-local
    name: Codex Local
    provider: codex
    model: gpt-5.6-sol
    reasoningEffort: high
    harness:
      id: codex-sdk
      version: local

  - id: claude-api
    name: Claude API
    provider: anthropic
    model: configured-model-id
    credential: anthropic-primary
    harness:
      id: agentbench-basic-loop
      version: 1
```

Files contain credential references, never secret values. Provider-specific
options live under a validated `options` object owned by that provider.

### `task.yaml`

```yaml
schemaVersion: 1
id: reproduce-result
name: Reproduce the reported result
prompt: prompt.md
fixtures:
  - fixtures/input.csv
resources:
  allowed: [browser, sandbox, desktop]
  planningRequired: true
  budget:
    browserSessions: 2
    sandboxes: 2
    desktops: 1
    totalMinutes: 30
submission:
  directory: submission
  required:
    - results.json
    - methodology.md
evaluators:
  - id: result-schema
    type: schema
    weight: 10
    config:
      subject: results.json
      schema: evaluators/results.schema.json
  - id: reproduce
    type: command
    weight: 60
    config:
      command: [python, evaluators/verify.py]
      network: false
  - id: methodology
    type: model-judge
    weight: 30
    config:
      rubric: rubrics/methodology.md
      judgeAgent: methodology-judge
```

Evaluator weights for an enabled task must total exactly 100. An evaluator may
declare prerequisites when its result is meaningless after another failure.
Cycles and references to unknown evaluators are invalid.

## Loading, Validation, and Snapshots

`BenchmarkLoader` follows this sequence:

1. Discover configured benchmark roots.
2. Resolve all paths relative to the pack root.
3. Reject absolute paths, traversal, escaping symlinks, duplicate IDs, unknown
   fields, missing referenced assets, invalid provider/evaluator types, invalid
   budgets, and evaluator weights that do not total 100.
4. Parse referenced text and data as bytes without interpolating environment
   variables or credentials.
5. Build a normalized in-memory `BenchmarkDefinition`.
6. Copy semantic inputs into a content-addressed snapshot directory using
   canonical path ordering and calculate its SHA-256 digest.
7. Persist the digest and normalized manifest with the run record.

Snapshot creation happens before provider preflight. A run with an invalid pack
is classified as `benchmark_invalid` and cannot consume provider or Solari
resources.

The loader never executes code. Evaluator code becomes executable only inside
the evaluator phase and under that evaluator's declared isolation policy.

## Dashboard Authoring Experience

The Studio uses a three-pane desktop layout:

- The left pane is a guided sequence: Basics, Tasks, Environment, Evaluators,
  Agents, and Review.
- The center pane edits the selected section using forms plus appropriate
  prompt, YAML, JSON, or rubric editors.
- The right pane shows the exact files that will be written and updates live.
- A persistent footer shows validation state and the current snapshot status.

The dashboard supports these workflows:

1. Create a benchmark from a blank pack or tutorial template.
2. Add, duplicate, reorder, enable, or disable tasks.
3. Define allowed Solari primitives and budgets per task.
4. Compose deterministic evaluators and model judges, with a visible weight
   total and prerequisite graph.
5. Add provider-backed agents and see credential availability without seeing
   credential values.
6. Validate and preview all generated files.
7. Save files atomically and launch a dry run or real run.

`AuthoringService` writes to temporary files in the target directory and uses
atomic replacement after the complete pack validates. It serializes writes per
pack. If files changed externally since the UI loaded them, saving returns a
conflict with the changed paths; the user must reload or deliberately overwrite.

The first release optimizes for desktop use. Read-only run monitoring remains
usable at narrower widths; full authoring may require a desktop-sized window.

## Agent Provider Contract

Providers implement one common lifecycle:

```ts
interface AgentProvider {
  describe(): AgentProviderDescription
  preflight(input: ProviderPreflightInput): Promise<ProviderPreflightResult>
  plan(input: ProviderPlanInput, signal: AbortSignal): Promise<RunPlan>
  execute(input: ProviderExecutionInput, sink: AgentEventSink,
          signal: AbortSignal): Promise<ProviderExecution>
  cancel(run: ProviderRunHandle): Promise<void>
}

type ProviderExecution = {
  handle: ProviderRunHandle
  result: Promise<ProviderExecutionResult>
}
```

- `describe` supplies capabilities and a redacted configuration schema for the
  UI.
- `preflight` validates local binaries, model configuration, named credential
  availability, task compatibility, and estimated resource requirements. It
  must not provision billable resources.
- `plan` returns the requested Solari primitives and justification. Providers
  that cannot plan natively use the platform's constrained planning prompt.
- `execute` starts work in a disposable workspace, returns a live handle plus a
  result promise, and emits normalized events while that result is pending.
- `cancel` stops the harness and any provider-owned child processes. The
  orchestrator remains responsible for final resource reconciliation.

Version-one built-ins are:

1. **Codex local provider** using the locally authenticated Codex runtime,
   preferably through the supported SDK/app-server boundary while preserving a
   CLI fallback during migration.
2. **Anthropic API provider** for raw Claude API access through the platform's
   basic tool loop.
3. **OpenAI-compatible API provider** with an explicit base URL, model ID, and
   named credential.
4. **Executable JSONL provider** for full local harnesses such as Claude Code
   or a user-owned agent executable.
5. **Presets** that bind a provider, harness, model, reasoning settings, and
   options under a stable agent ID.

Built-ins are compiled and registered by the application. Version one does not
load arbitrary JavaScript provider plugins from benchmark folders.

### Normalized events

Providers translate native output into a stable event envelope:

```ts
type AgentEvent = {
  schemaVersion: 1
  sequence: number
  occurredAt: string
  kind:
    | "message"
    | "reasoning-summary"
    | "tool-request"
    | "tool-result"
    | "resource-created"
    | "resource-observation"
    | "artifact"
    | "usage"
    | "warning"
    | "error"
  provider: string
  payload: unknown
}
```

Provider-native raw events may be retained as redacted evidence, but the live
dashboard and lifecycle logic consume normalized events. Unsupported concepts
are represented as provider metadata rather than fabricated equivalents.

### Model and harness identity

Every result records separately:

- provider and provider adapter version;
- requested and resolved model identity;
- harness ID and version;
- reasoning or sampling configuration;
- tool policy and allowed Solari primitives;
- benchmark snapshot digest;
- evaluator versions and judge identities.

The scoreboard may compare any selected results, but it displays a comparability
warning when harness, task snapshot, evaluator set, or material resource policy
differs. It never labels those rows as a controlled model-only comparison.

## Credentials

`CredentialStore` exposes metadata and scoped resolution:

```ts
interface CredentialStore {
  listMetadata(): Promise<CredentialMetadata[]>
  has(ref: string): Promise<boolean>
  withCredential<T>(ref: string, use: (secret: SecretValue) => Promise<T>): Promise<T>
}
```

Supported local sources are environment variables and an optional OS-backed or
gitignored local credential configuration. Public benchmark files contain only
references such as `anthropic-primary` or `solari-default`.

Secret values:

- are never returned by dashboard APIs;
- are never written to benchmark snapshots, SQLite, evidence, or logs;
- are injected only into the provider or subprocess that needs them;
- are removed from child environments unless explicitly scoped;
- are covered by centralized redaction of exact values and credential-shaped
  output;
- are not exposed to command evaluators or model judges unless that evaluator
  references a separately authorized credential.

The public repository includes examples and setup documentation, not working
credentials. A private demonstration environment can bind the same references
to real local secrets without maintaining a divergent source tree.

## Evaluators and Scoring

The built-in evaluator types are:

- **file**: presence, absence, size, digest, and text checks.
- **schema**: JSON or YAML schema validation.
- **command**: task-authored executable verification in a clean Solari sandbox.
- **http**: request/response assertions against a verifier-owned deployment.
- **browser**: recorded navigation and DOM assertions in a clean Solari browser.
- **numeric**: exact, tolerance, distribution, and reproducibility comparisons.
- **model-judge**: rubric-based assessment by a configured provider and model.

All evaluators return a common result:

```ts
type EvaluatorResult = {
  evaluatorId: string
  status: "passed" | "failed" | "error" | "skipped"
  earnedPoints: number
  possiblePoints: number
  summary: string
  assertions: EvaluatorAssertion[]
  evidence: EvidenceReference[]
  metadata: Record<string, unknown>
}
```

The primary score is the sum of earned weighted points and is normalized to
100. A model judge may contribute any author-selected percentage, including the
entire score. The UI clearly labels judged points and shows the exact rubric,
judge provider, resolved model, sampling configuration, prompt digest, raw
redacted response, parsed result, and retries. The platform does not imply that
a model-judged score is deterministic.

Model-judge output must validate against a generated schema. One repair attempt
may be made for syntactically invalid output; further failure is an evaluator
error, not a zero-quality assertion. Judge API or infrastructure failure is
also an evaluator error.

Command evaluators run in a fresh Solari sandbox with network disabled by
default, a read-only benchmark snapshot, a read-only scanned submission, a
writable result directory, bounded CPU/time/output, and no inherited secrets.
Network access must be explicit in the evaluator configuration and is visible
in the run preflight.

The platform distinguishes:

- **failed assertion**: the submission did not satisfy a valid evaluator;
- **evaluator error**: the evaluator could not produce a valid judgment;
- **invalid benchmark**: configuration or evaluator setup was defective.

The first produces earned points according to the evaluator result. The latter
two prevent a trustworthy final score and are displayed separately rather than
silently converted to zero.

## Evidence Model

Evidence is content-addressed and immutable. Each item records:

- SHA-256 digest and byte size;
- MIME type and logical role;
- producer: agent, provider, orchestrator, or evaluator;
- task, run, and evaluator association;
- creation time and redaction status;
- local path or external replay reference;
- retention state.

Evidence includes sanitized logs, normalized and optional native events,
screenshots, browser recording references, resource observations, assertions,
plots, generated data, submission files, evaluator output, and cleanup reports.

The dashboard can show transient Solari replay URLs, but durable local evidence
and machine-readable assertions remain canonical when external retention ends.

## Run Lifecycle

One job still represents one agent configuration and one task. A matrix expands
into independent jobs subject to the local concurrency limit.

```text
queued -> loading -> preflight -> planning -> generating -> packaging
       -> evaluating -> capturing -> completed
             |             |             |
             +-------------+-------------+----> failed or cancelled
```

The lifecycle is:

1. Resolve the benchmark, task, and agent IDs.
2. Validate the complete pack and create its immutable snapshot.
3. Resolve provider capabilities and named credential availability.
4. Preflight local dependencies, task compatibility, budgets, and the maximum
   potential Solari footprint without provisioning.
5. For an interactive paid run, display the resource summary and require the
   existing explicit launch action. Non-interactive CLI use requires its
   corresponding confirmation flag; dry runs never provision.
6. Ask the provider for a schema-valid resource plan and validate it against the
   task's allow-list and budgets.
7. Create a disposable execution workspace containing only the permitted task
   inputs, fixtures, and submission contract—not evaluator implementations or
   expected outputs unless the author explicitly marks them visible.
8. Execute the provider with deadlines, cancellation, normalized event capture,
   and run-scoped Solari access.
9. Scan and package the declared submission, rejecting traversal, symlinks,
   secrets, oversized files, dependency caches, and out-of-contract paths.
10. Run evaluators against the package in clean resources, respecting declared
    prerequisites but retaining every result.
11. Calculate the score only when all required evaluators produced valid
    outcomes.
12. Capture final evidence and reconcile browser, sandbox, and desktop
    inventories in `finally` paths.
13. Persist the terminal result even when execution, evaluation, evidence
    capture, cancellation, or cleanup fails.

Edits made after step 2 affect only future runs.

## Persistence and API Changes

SQLite remains the source of run state. Migrations add normalized records for:

- benchmark ID, declared version, snapshot digest, and snapshot location;
- provider, resolved model, harness, and execution configuration;
- provider preflight and validated resource plan;
- evaluator definitions, results, assertions, and judge metadata;
- evidence digests and associations;
- comparability dimensions and warnings.

Benchmark definitions themselves remain file-backed. SQLite may cache discovery
and validation results for responsiveness, but caches are disposable and keyed
by content digest.

Existing dashboard and CLI endpoints remain compatible during migration. New
APIs are grouped around benchmark discovery/authoring, provider metadata,
credential metadata, validation, dry-run preflight, run launch, normalized event
streaming, evaluator results, and evidence retrieval.

No API returns raw credentials or arbitrary local filesystem contents.

## Failure Handling

Failure codes are extended with typed configuration and evaluation outcomes,
including:

- `benchmark_invalid`
- `benchmark_conflict`
- `provider_unavailable`
- `provider_incompatible`
- `credential_missing`
- `preflight_failed`
- `plan_invalid`
- `agent_timeout`
- `agent_failed`
- `submission_invalid`
- `provision_failed`
- `evaluator_error`
- `score_invalid`
- `evidence_failed`
- `cleanup_failed`
- `cancelled`

Cleanup issues remain secondary outcomes and never overwrite the primary run
result. Transient provider or infrastructure operations may retry only when the
adapter declares them idempotent. Agent output, failed assertions, malformed
submissions, and deterministic evaluator failures are not automatically retried.

## Migration Strategy

The platform is delivered incrementally:

### Phase 1: File-backed domain

- Define strict versioned schemas and `BenchmarkLoader`.
- Convert the URL Shortener and Same Stats tasks into
  `benchmarks/tutorials/agentbench-live` without changing expected behavior.
- Add content snapshots while adapting the current task registry to read them.
- Preserve the existing CLI commands and run detail pages.

### Phase 2: Provider boundary

- Combine the current `CodexPlanner` and `CodexGenerator` behavior behind the
  `AgentProvider` lifecycle.
- Add normalized events and explicit model/harness identity.
- Add the credential metadata/resolution boundary.
- Add raw API and executable JSONL providers after provider contract tests pass.

### Phase 3: Evaluator pipeline

- Adapt current verifiers to built-in evaluator declarations and task-owned
  command assets.
- Add weighted result aggregation, content-addressed evidence, and model judges.
- Prove migrated tutorial outcomes match existing known pass/fail fixtures and
  score totals.

### Phase 4: Studio

- Add discovery and validation APIs.
- Implement the three-pane authoring wizard and generated-file preview.
- Add atomic writes, external-edit conflict detection, dry-run preflight, and
  launch integration.

During all phases, compatibility adapters keep the working orchestrator usable.
The hardcoded registries are removed only after their file-backed replacements
pass regression tests.

## Testing Strategy

### Schema and loader tests

- Valid minimal and full benchmark packs.
- Unknown fields, duplicate IDs, missing assets, invalid weights, invalid
  prerequisites, cycles, traversal, absolute paths, and escaping symlinks.
- Stable digests across repeated loads and canonical path ordering.
- Snapshot immutability while source files change.
- Explicit schema migration fixtures.

### Provider contract tests

Every provider runs the same suite for capability description, credential
preflight, plan validation, normalized event ordering, cancellation, timeout,
process cleanup, redaction, malformed output, and usage reporting. Fake native
streams cover failures without paid calls.

### Evaluator contract tests

Every evaluator runs known passing, failing, malformed, timeout, and
infrastructure-error fixtures. Tests verify scoring, prerequisites, evidence,
network defaults, output limits, judge schema repair, and the distinction
between assertion failure and evaluator failure.

### End-to-end tests

- Deterministic fake providers exercise the complete run pipeline.
- The Studio round-trip test creates or edits a pack, saves it, reloads it, and
  proves semantic equality.
- External file edits trigger a save conflict rather than data loss.
- Cancellation and every failure stage trigger resource reconciliation.
- SSE clients receive ordered normalized events and terminal status.
- Existing tutorial passing/failing submissions retain expected outcomes and
  score totals after migration.

### Security tests

- Submission and benchmark path traversal and symlink escape.
- Exact-secret and credential-pattern redaction in native events, normalized
  events, logs, evaluator output, and error messages.
- Child environment allow-listing.
- Command evaluator isolation, no-network default, time/output bounds, and no
  credential inheritance.
- Dashboard APIs cannot retrieve secret values or arbitrary files.

### Opt-in live smoke tests

- Codex local preflight and one minimal execution.
- One Solari sandbox command.
- One recorded Solari browser navigation.
- One Solari desktop screenshot.
- One tutorial task through the complete provider and evaluator pipeline.

Paid live tests never run as part of the default unit test command.

## Operational Scope and Safety

Version one is a trusted-author, local single-user application. Benchmark code
and evaluator commands are trusted like repository code. Agent-generated
submissions, fetched content, and model output are untrusted and cross isolation
boundaries before execution or rendering.

The in-process queue and SQLite database remain appropriate for this scope.
Default concurrency is one, and configured concurrency cannot exceed the
active Solari plan or task budgets. Dry run is available for every benchmark.
The launch surface shows maximum sessions, desktops, sandboxes, wall time,
network-enabled evaluators, and model judges before paid resources are used.

Local working data, snapshots, credentials, and brainstorming artifacts remain
gitignored. Only deliberately curated and redacted demonstration evidence may
be copied into public assets.

## Definition of Done

The custom platform release is complete when:

- A user can create a benchmark in the Studio, inspect the generated files,
  save them, edit them externally, reload them, and run them.
- A clean checkout includes valid tutorial packs for both existing tasks.
- The current Codex baseline runs through the new provider contract.
- At least one raw API provider and the executable JSONL provider pass the
  shared provider contract suite.
- Tasks can allow browser, sandbox, desktop, or any combination, and the agent's
  validated plan decides what is provisioned.
- All seven evaluator types produce normalized results and evidence.
- Model judges can contribute an author-selected portion of the primary score
  with complete judge provenance.
- Every run records an immutable benchmark digest, provider/model/harness
  identity, evaluator versions, and evidence digests.
- Invalid benchmarks and evaluator errors cannot produce apparently valid zero
  scores.
- No credential value appears in benchmark files, snapshots, APIs, SQLite,
  logs, or committed artifacts.
- Migrated tutorials preserve their expected pass/fail fixtures and scores.
- Unit, contract, integration, security, build, typecheck, and opt-in live smoke
  suites pass at their documented levels.
- The public README documents authoring, provider setup, credentials, scoring,
  evidence, Solari costs, security boundaries, and tutorial usage.

## Deferred Extensions

The architecture leaves room for, but does not implement in version one:

- signed benchmark bundles and a remote marketplace;
- hosted execution and team workspaces;
- distributed workers and durable queues;
- remotely managed credentials;
- third-party runtime plugin installation;
- statistical repeated-run experiments and confidence intervals;
- cross-machine artifact storage and retention policies.

These require explicit designs rather than implicit expansion of the local
trust model.
