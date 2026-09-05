# File-Backed Benchmark Domain Implementation Plan

> Historical design/plan. For shipped behavior, current budgets, verified results
> and known limitations, see the [current implementation guide](../../../agentbench-live/docs/current-state.md).
> This document preserves earlier intent; it is not a release or live certificate.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded task and agent configuration with validated YAML benchmark packs and immutable content snapshots without changing existing tutorial behavior.

**Architecture:** Zod schemas define the version-one file contract, a path-safe `BenchmarkLoader` resolves and snapshots semantic inputs, and a `BenchmarkCatalog` supplies compatibility lookups to the current orchestrator. The current task and agent types remain available as projections during this phase so the live pipeline stays operational.

**Tech Stack:** TypeScript 5, Node.js 20+, Zod 4, YAML, Vitest 4, SHA-256, SQLite.

**Spec:** `docs/superpowers/specs/2026-09-04-custom-agentbench-platform-design.md`

## Global Constraints

- Benchmark files are canonical and use strict `schemaVersion: 1` schemas.
- Reject absolute paths, traversal, escaping symlinks, duplicate IDs, unknown fields, missing assets, invalid budgets, evaluator dependency cycles, and enabled weights not totaling 100.
- Snapshot semantic files before provider preflight and identify the snapshot by SHA-256.
- Snapshot ordering and digest calculation must be stable across operating systems.
- Existing URL Shortener and Same Stats prompts, budgets, allowed primitives, and verifier IDs must remain unchanged.
- No paid network calls occur in this plan's tests.

---

### Task 1: Versioned benchmark schemas

**Files:**
- Modify: `agentbench-live/package.json`
- Modify: `agentbench-live/package-lock.json`
- Create: `agentbench-live/src/core/benchmarks/schema.ts`
- Create: `agentbench-live/src/core/benchmarks/types.ts`
- Test: `agentbench-live/tests/benchmarks/schema.test.ts`

**Interfaces:**
- Consumes: existing `Primitive` from `src/core/domain/plan.ts`.
- Produces: `BenchmarkFileSchema`, `AgentsFileSchema`, `TaskFileSchema`, `BenchmarkDefinition`, `BenchmarkTaskDefinition`, `AgentDefinition`, and `BenchmarkValidationError`.

- [ ] **Step 1: Install the YAML parser**

Run: `cd agentbench-live && npm install yaml`

Expected: `package.json` and `package-lock.json` add `yaml` under runtime dependencies.

- [ ] **Step 2: Write failing strict-schema tests**

Create `tests/benchmarks/schema.test.ts` with tests that parse one valid pack fragment and reject an unknown task key, duplicate evaluator ID, negative budget, missing prompt path, and evaluator weights totaling 90:

```ts
import { describe, expect, it } from "vitest";
import { parseTaskFile } from "@/core/benchmarks/schema";

const valid = {
  schemaVersion: 1,
  id: "reproduce-result",
  name: "Reproduce result",
  prompt: "prompt.md",
  fixtures: ["fixtures/input.csv"],
  resources: {
    allowed: ["browser", "sandbox", "desktop"],
    planningRequired: true,
    budget: {
      browserSessions: 1,
      sandboxes: 1,
      desktops: 1,
      totalMinutes: 10,
    },
  },
  submission: { directory: "submission", required: ["results.json"] },
  compatibility: {
    requiredEvidence: ["sandbox"],
    legacyVerifier: "same-stats-different-graph",
    legacyBudgetMs: {
      totalMs: 300000,
      browserMs: 60000,
      sandboxMs: 180000,
      desktopMs: 0,
    },
  },
  evaluators: [
    { id: "shape", type: "schema", weight: 100, config: {} },
  ],
};

describe("parseTaskFile", () => {
  it("accepts a strict version-one task", () => {
    expect(parseTaskFile(valid).id).toBe("reproduce-result");
  });

  it("rejects unknown keys", () => {
    expect(() => parseTaskFile({ ...valid, typo: true })).toThrow(
      /Unrecognized key.*typo/i,
    );
  });

  it("requires enabled weights to total 100", () => {
    const evaluators = [{ ...valid.evaluators[0], weight: 90 }];
    expect(() => parseTaskFile({ ...valid, evaluators })).toThrow(
      /weights.*100/i,
    );
  });
});
```

- [ ] **Step 3: Run the schema test and verify it fails**

Run: `cd agentbench-live && npm test -- tests/benchmarks/schema.test.ts`

Expected: FAIL because `@/core/benchmarks/schema` does not exist.

- [ ] **Step 4: Implement strict schemas and domain types**

In `types.ts`, define the stable loaded types:

```ts
export type EvaluatorType =
  | "file" | "schema" | "command" | "http"
  | "browser" | "numeric" | "model-judge";

export type EvaluatorDefinition = {
  id: string;
  type: EvaluatorType;
  weight: number;
  enabled: boolean;
  prerequisites: string[];
  config: Record<string, unknown>;
};

export type BenchmarkTaskDefinition = {
  id: string;
  name: string;
  promptPath: string;
  prompt: string;
  fixtures: string[];
  allowedPrimitives: Array<"browser" | "sandbox" | "desktop">;
  planningRequired: boolean;
  resourceLimits: {
    browserSessions: number;
    sandboxes: number;
    desktops: number;
    totalMinutes: number;
  };
  submission: { directory: string; required: string[] };
  compatibility?: {
    requiredEvidence: Array<"browser" | "sandbox" | "desktop">;
    legacyVerifier: string;
    legacyBudgetMs: {
      totalMs: number;
      browserMs: number;
      sandboxMs: number;
      desktopMs: number;
    };
  };
  evaluators: EvaluatorDefinition[];
};

export type AgentDefinition = {
  id: string;
  name: string;
  provider: string;
  model?: string;
  reasoningEffort?: string;
  credential?: string;
  harness: { id: string; version: string };
  options: Record<string, unknown>;
};

export type BenchmarkDefinition = {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description?: string;
  root: string;
  defaults: {
    timeoutSeconds: number;
    maxConcurrency: number;
    submissionDirectory: string;
  };
  tasks: BenchmarkTaskDefinition[];
  agents: AgentDefinition[];
};
```

In `schema.ts`, build `.strict()` Zod objects, transform omitted evaluator
`enabled` to `true`, `prerequisites` to `[]`, and `config`/agent `options` to
`{}`. Use `superRefine` to enforce unique IDs, exact weight total, known
prerequisites, and an acyclic prerequisite graph. Export parsing functions that
throw `BenchmarkValidationError` with a `diagnostics` array containing
`path`, `code`, and `message`.

- [ ] **Step 5: Run focused and full validation**

Run: `cd agentbench-live && npm test -- tests/benchmarks/schema.test.ts && npm run typecheck`

Expected: both commands PASS.

- [ ] **Step 6: Commit the schema boundary**

```bash
git add agentbench-live/package.json agentbench-live/package-lock.json agentbench-live/src/core/benchmarks agentbench-live/tests/benchmarks/schema.test.ts
git commit -m "feat(agentbench): define benchmark pack schemas"
```

### Task 2: Path-safe loader and immutable snapshots

**Files:**
- Create: `agentbench-live/src/core/benchmarks/paths.ts`
- Create: `agentbench-live/src/core/benchmarks/snapshot.ts`
- Create: `agentbench-live/src/core/benchmarks/loader.ts`
- Test: `agentbench-live/tests/benchmarks/loader.test.ts`
- Test: `agentbench-live/tests/benchmarks/snapshot.test.ts`

**Interfaces:**
- Consumes: parsing functions and domain types from Task 1; `YAML.parse`.
- Produces: `BenchmarkLoader.load(packRoot): Promise<LoadedBenchmark>`, `LoadedBenchmark = { definition, snapshot }`, and `BenchmarkSnapshot = { digest, root, files }`.

- [ ] **Step 1: Write loader security tests using temporary directories**

Create a fixture helper in `loader.test.ts` that writes a minimal valid pack.
Test successful prompt loading plus rejection of `../prompt.md`, an absolute
prompt path, a missing fixture, duplicate task IDs across folders, and a symlink
whose real path leaves the pack root. Skip only the symlink case when Windows
returns an explicit privilege error.

```ts
it("rejects a prompt outside the pack root", async () => {
  const fixture = await createPack();
  await writeFile(join(fixture.root, "tasks/task/task.yaml"),
    fixture.taskYaml.replace("prompt.md", "../../../outside.md"));
  await expect(new BenchmarkLoader(fixture.snapshots).load(fixture.root))
    .rejects.toThrow(/path escapes benchmark root/i);
});
```

- [ ] **Step 2: Write deterministic snapshot tests**

Assert two loads of identical content produce the same digest, modification of
`prompt.md` changes the digest, source edits after loading do not change bytes
inside the returned snapshot, and creation order does not change the digest.

- [ ] **Step 3: Run loader tests and verify they fail**

Run: `cd agentbench-live && npm test -- tests/benchmarks/loader.test.ts tests/benchmarks/snapshot.test.ts`

Expected: FAIL because the loader modules do not exist.

- [ ] **Step 4: Implement safe path resolution**

In `paths.ts`, export:

```ts
export async function resolvePackFile(
  packRoot: string,
  relativePath: string,
): Promise<string>;
```

Reject empty paths, absolute paths, NUL bytes, `..` segments, directories, and
real paths outside `realpath(packRoot)`. Compare normalized path segments with
case-insensitive comparison on Windows; do not rely on string-prefix matching.

- [ ] **Step 5: Implement canonical snapshot creation**

In `snapshot.ts`, export:

```ts
export type BenchmarkSnapshot = {
  digest: string;
  root: string;
  files: ReadonlyArray<{ path: string; digest: string; size: number }>;
};

export async function createBenchmarkSnapshot(input: {
  packRoot: string;
  semanticFiles: string[];
  snapshotsRoot: string;
}): Promise<BenchmarkSnapshot>;
```

Normalize relative paths to `/`, sort them by UTF-8 byte order, and hash each
entry as `pathByteLength + NUL + path + contentByteLength + NUL + content`.
Write to `<snapshotsRoot>/.tmp-<uuid>`, then atomically rename to
`<snapshotsRoot>/<digest>`. If the digest directory already exists, discard the
temporary directory after verifying its manifest. Mark the returned arrays
readonly and never mutate snapshot contents.

- [ ] **Step 6: Implement `BenchmarkLoader`**

Load `benchmark.yaml`, `agents.yaml`, each `taskRoots/*/task.yaml`, prompts,
fixtures, evaluator-referenced local assets, and rubrics. Parse YAML as data;
do not interpolate environment variables. Return normalized definitions plus
the snapshot. Sort tasks and agents by ID for deterministic discovery.

- [ ] **Step 7: Run focused tests, security tests, and typecheck**

Run: `cd agentbench-live && npm test -- tests/benchmarks tests/core/security.test.ts && npm run typecheck`

Expected: all commands PASS.

- [ ] **Step 8: Commit loading and snapshots**

```bash
git add agentbench-live/src/core/benchmarks agentbench-live/tests/benchmarks
git commit -m "feat(agentbench): load and snapshot benchmark packs"
```

### Task 3: Migrate the tutorial benchmark to canonical files

**Files:**
- Create: `agentbench-live/benchmarks/tutorials/agentbench-live/benchmark.yaml`
- Create: `agentbench-live/benchmarks/tutorials/agentbench-live/agents.yaml`
- Create: `agentbench-live/benchmarks/tutorials/agentbench-live/tasks/url-shortener/task.yaml`
- Create: `agentbench-live/benchmarks/tutorials/agentbench-live/tasks/url-shortener/prompt.md`
- Create: `agentbench-live/benchmarks/tutorials/agentbench-live/tasks/same-stats-different-graph/task.yaml`
- Create: `agentbench-live/benchmarks/tutorials/agentbench-live/tasks/same-stats-different-graph/prompt.md`
- Create: `agentbench-live/benchmarks/tutorials/agentbench-live/tasks/same-stats-different-graph/fixtures/seed.csv`
- Create: `agentbench-live/src/core/benchmarks/catalog.ts`
- Modify: `agentbench-live/src/core/tasks/registry.ts`
- Test: `agentbench-live/tests/benchmarks/tutorials.test.ts`

**Interfaces:**
- Consumes: `BenchmarkLoader.load` from Task 2 and current task constants from `src/core/tasks/url-shortener.ts` and `same-stats.ts` as regression oracles.
- Produces: `BenchmarkCatalog.discover()`, `getBenchmark(id)`, `getTask(id)`, `getAgent(id)`, `listTasks()`, and `listAgents()`.

- [ ] **Step 1: Write a migration regression test**

Load the tutorial pack and compare every projected legacy field to the current
constants: IDs, titles, versions, full prompt strings, primitive arrays,
evidence requirements, budgets, models, reasoning effort, and verifier IDs.
Also assert the copied seed bytes equal `sameStatsSeedCsv` after normalizing the
final newline.

- [ ] **Step 2: Run the migration test and verify it fails**

Run: `cd agentbench-live && npm test -- tests/benchmarks/tutorials.test.ts`

Expected: FAIL because the tutorial pack and catalog do not exist.

- [ ] **Step 3: Create the tutorial pack**

Use benchmark ID `agentbench-live`, version `1.0.0`, timeout 300 seconds,
concurrency 1, and submission directory `submission`. Define agents `sol-low`
and `luna-high` with provider `codex`, harness `codex-sdk`, their existing model
IDs, and their existing reasoning efforts. Move the prompt text byte-for-byte
from the current task modules into `prompt.md`; move `sameStatsSeedCsv` into the
fixture file. Declare a temporary evaluator of type `command` and weight 100.
Add the schema-defined `compatibility` object shown in Task 1 with the current
required evidence, verifier ID, and exact per-primitive millisecond budget.
This object is consumed only until Phase 3.

- [ ] **Step 4: Implement the catalog and compatibility projection**

```ts
export class BenchmarkCatalog {
  constructor(
    private readonly roots: string[],
    private readonly loader: BenchmarkLoader,
  ) {}

  discover(): Promise<LoadedBenchmark[]>;
  getBenchmark(id: string): Promise<LoadedBenchmark>;
  getTask(id: string): Promise<TaskManifest>;
  getAgent(id: string): Promise<AgentConfig>;
  listTasks(): Promise<TaskManifest[]>;
  listAgents(): Promise<AgentConfig[]>;
}
```

The compatibility projection reads `compatibility.legacyBudgetMs`,
`compatibility.requiredEvidence`, and `compatibility.legacyVerifier`. Reject
task or agent ID collisions across configured
packs with an error naming both roots.

- [ ] **Step 5: Run tutorial, domain, and verifier regression tests**

Run: `cd agentbench-live && npm test -- tests/benchmarks/tutorials.test.ts tests/core/domain.test.ts tests/verifiers`

Expected: all commands PASS.

- [ ] **Step 6: Commit the tutorial migration**

```bash
git add agentbench-live/benchmarks agentbench-live/src/core/benchmarks/catalog.ts agentbench-live/src/core/tasks/registry.ts agentbench-live/tests/benchmarks/tutorials.test.ts
git commit -m "feat(agentbench): migrate tutorials to benchmark files"
```

### Task 4: Persist snapshot and comparability identity

**Files:**
- Modify: `agentbench-live/src/core/domain/run.ts`
- Modify: `agentbench-live/src/core/persistence/repository.ts`
- Modify: `agentbench-live/src/core/persistence/schema.sql`
- Modify: `agentbench-live/src/core/persistence/sqlite-repository.ts`
- Create: `agentbench-live/src/core/persistence/migrations.ts`
- Modify: `agentbench-live/tests/core/persistence.test.ts`

**Interfaces:**
- Consumes: `BenchmarkSnapshot` from Task 2.
- Produces: persisted `benchmarkId`, `benchmarkVersion`, `benchmarkDigest`, `snapshotPath`, `providerId`, `harnessId`, and `harnessVersion` fields on `RunRecord`.

- [ ] **Step 1: Add failing persistence round-trip and migration tests**

Create a database using the old schema columns, open it with
`SqliteRunRepository`, create/update a run with all new identity fields, close
and reopen it, and assert exact values survive. Assert `PRAGMA user_version`
equals `2` afterward.

- [ ] **Step 2: Run the persistence test and verify it fails**

Run: `cd agentbench-live && npm test -- tests/core/persistence.test.ts`

Expected: FAIL because the run type and database lack snapshot identity.

- [ ] **Step 3: Implement additive SQLite migration 2**

Create a transaction-based migration runner keyed by `PRAGMA user_version`.
Migration 1 records the current schema as version 1. Migration 2 adds nullable
columns `benchmark_id`, `benchmark_version`, `benchmark_digest`,
`snapshot_path`, `provider_id`, `harness_id`, and `harness_version`, then sets
`user_version = 2`. New databases receive the complete current schema and
version 2. Never drop or rewrite existing run rows.

- [ ] **Step 4: Extend repository mappings and inputs**

Add the seven fields to `RunRecord` and `CreateRunInput`; map each field in
`RunRow`, `fromRunRow`, `insert`, and `persistUpdate`. Keep all fields optional
so existing seeded demo JSON and historical rows remain readable.

- [ ] **Step 5: Run persistence, demo, and API tests**

Run: `cd agentbench-live && npm test -- tests/core/persistence.test.ts tests/core/demo.test.ts tests/app/run-api.test.ts && npm run typecheck`

Expected: all commands PASS.

- [ ] **Step 6: Commit persisted benchmark identity**

```bash
git add agentbench-live/src/core/domain/run.ts agentbench-live/src/core/persistence agentbench-live/tests/core/persistence.test.ts
git commit -m "feat(agentbench): persist benchmark snapshot identity"
```

### Task 5: Integrate catalog snapshots with the current runner

**Files:**
- Modify: `agentbench-live/src/core/runner/contracts.ts`
- Modify: `agentbench-live/src/core/runner/orchestrator.ts`
- Modify: `agentbench-live/src/core/runner/state-machine.ts`
- Modify: `agentbench-live/src/server/container.ts`
- Modify: `agentbench-live/src/cli.ts`
- Modify: `agentbench-live/tests/core/orchestrator.test.ts`
- Modify: `agentbench-live/tests/integration/cli.test.ts`
- Modify: `agentbench-live/tests/integration/pipeline.test.ts`
- Modify: `agentbench-live/README.md`

**Interfaces:**
- Consumes: `BenchmarkCatalog` and `LoadedBenchmark` from Tasks 2–3.
- Produces: snapshot-before-preflight behavior and `AGENTBENCH_BENCHMARK_ROOTS` configuration while retaining existing CLI command names.

- [ ] **Step 1: Write failing orchestration tests**

Change test dependencies to resolve a `RunSelection` atomically:

```ts
export type RunSelection = {
  benchmark: BenchmarkDefinition;
  snapshot: BenchmarkSnapshot;
  task: TaskManifest;
  agent: AgentConfig;
};
```

Assert selection happens before planning, its digest is stored at run creation,
and editing source files after `create()` cannot change the prompt passed to
the planner or generator. Assert loader failure creates no run and invokes no
provider or Solari fake.

- [ ] **Step 2: Run orchestrator tests and verify they fail**

Run: `cd agentbench-live && npm test -- tests/core/orchestrator.test.ts`

Expected: FAIL because the orchestrator still calls separate synchronous
`getTask` and `getAgent` functions.

- [ ] **Step 3: Add `loading` and `preflight` stages**

Extend `RunStage` and state transitions to:

```text
queued -> loading -> preflight -> planning -> generating -> provisioning
       -> building -> verifying -> capturing -> completed
```

Compatibility note: benchmark loading occurs immediately before a durable run
exists; the first persisted stage transition records `loading` after the
selection snapshot is available. Update the stage timeline and recovery mapping
so historical stage names still render.

- [ ] **Step 4: Refactor runner dependencies around immutable selection**

Replace `getTask` and `getAgent` with:

```ts
resolveSelection(request: RunRequest): Promise<RunSelection>;
preflight(selection: RunSelection): Promise<void>;
```

Make `create` and `run` asynchronous. Persist snapshot identity in `create`,
then pass the same `RunSelection` instance through planning and generation.
Keep existing deadline and cleanup helpers unchanged.

- [ ] **Step 5: Compose the catalog in CLI and server**

Resolve benchmark roots from `AGENTBENCH_BENCHMARK_ROOTS`, split with
`path.delimiter`, and default to
`<project>/benchmarks/tutorials/agentbench-live`. Store snapshots under
`AGENTBENCH_SNAPSHOT_PATH` or `.agentbench/snapshots`. Update selection errors
to return typed `unknown_benchmark`, `unknown_task`, `unknown_agent`, or
`benchmark_invalid` results without leaking absolute paths.

- [ ] **Step 6: Update CLI compatibility and documentation**

Keep `dry-run`, `run`, `matrix`, `smoke`, and `demo:seed`. Add optional
`--benchmark <id>` to `dry-run`, `run`, and `matrix`; default to
`agentbench-live`. Document the pack structure, snapshot directory, environment
variables, and commands with concrete tutorial examples.

- [ ] **Step 7: Run the complete phase gate**

Run: `cd agentbench-live && npm test && npm run typecheck && npm run lint && npm run build`

Expected: every command PASS; no Solari or model call occurs.

- [ ] **Step 8: Commit catalog integration**

```bash
git add agentbench-live/src agentbench-live/tests agentbench-live/README.md
git commit -m "feat(agentbench): run immutable benchmark snapshots"
```
