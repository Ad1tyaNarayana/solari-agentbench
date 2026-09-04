# Task 1 report: versioned benchmark schemas

## Implementation

- Added runtime `yaml` dependency and lockfile entry.
- Added stable benchmark domain types and `BenchmarkValidationError` diagnostics.
- Added strict schema parsers for task, agents, and benchmark files. Parsers accept YAML strings or object values, reject unknown fields, apply evaluator defaults, enforce non-negative budgets, unique IDs/prerequisites, enabled evaluator weights totaling exactly 100, known prerequisites, and acyclic prerequisite graphs.
- Task parsing maps the canonical prompt path into both `promptPath` and the no-I/O `prompt` field; no filesystem or provider calls are performed.

## Files

- `agentbench-live/package.json`
- `agentbench-live/package-lock.json`
- `agentbench-live/src/core/benchmarks/schema.ts`
- `agentbench-live/src/core/benchmarks/types.ts`
- `agentbench-live/tests/benchmarks/schema.test.ts`

## Tests and TDD evidence

- RED: `pnpm.cmd test -- tests/benchmarks/schema.test.ts --lockfile=false` failed because `@/core/benchmarks/schema` did not exist (plus an unrelated pre-existing orchestrator failure in the broad default run).
- GREEN focused: `pnpm.cmd exec vitest run tests/benchmarks/schema.test.ts` — 1 file, 6 tests passed.
- GREEN full: `pnpm.cmd exec vitest run` — 23 files, 116 passed, 1 skipped.
- Typecheck: `pnpm.cmd exec tsc --noEmit` reaches the existing unrelated error `src/app/layout.tsx(21,50): Cannot find name 'LayoutProps'`.

## Self-review

Schemas are strict at every contract object boundary, defaults are applied only to omitted optional evaluator/agent fields, validation diagnostics preserve Zod paths/codes, and graph validation handles unknown references before traversal and detects cycles.

## Concerns

The repository currently has a pre-existing `LayoutProps` typecheck error. The design document describes `benchmark.yaml` with `taskRoots`, while the task brief’s stable `BenchmarkDefinition` requires `root` and `tasks`; implementation follows the task brief contract exactly.

## Fix Round 1

### Findings addressed

1. Exported public `TaskFileSchema`, `AgentsFileSchema`, and `BenchmarkFileSchema` symbols.
2. Added safe-relative path validation for prompt, fixtures, submission paths, benchmark `taskRoots`, and submission directory; rejects POSIX absolute, Windows drive absolute, and `..` traversal forms.
3. Wrapped YAML parsing so syntax failures become `BenchmarkValidationError` diagnostics.
4. Changed benchmark parsing to the canonical design-spec manifest (`taskRoots`, with no embedded normalized `root`, `tasks`, or `agents`) and added `BenchmarkFileManifest`.

### TDD evidence

Covering tests added to `agentbench-live/tests/benchmarks/schema.test.ts` for all public exports, unsafe paths (`/tmp`, `C:\\tmp`, `../../`), malformed YAML, and canonical task roots.

RED command: `pnpm.cmd exec vitest run tests/benchmarks/schema.test.ts` — 16 tests, 10 failed as expected: missing exports, unsafe paths accepted, raw YAML parse error, and old benchmark shape rejected.

GREEN command: `pnpm.cmd exec vitest run tests/benchmarks/schema.test.ts` — 1 file, 16 tests passed.

Full validation: `pnpm.cmd exec vitest run` — 23 files, 126 tests passed, 1 skipped.

Typecheck: `pnpm.cmd exec tsc --noEmit` — exit 2 due solely to pre-existing `src/app/layout.tsx(21,50): Cannot find name 'LayoutProps'`.

### Files changed

- `agentbench-live/src/core/benchmarks/schema.ts`
- `agentbench-live/src/core/benchmarks/types.ts`
- `agentbench-live/tests/benchmarks/schema.test.ts`

### Commit and concerns

Commit: pending until report append is committed.

Concern remains the unrelated repository typecheck error noted above.
