# Task 3 report: tutorial benchmark migration

## Implementation

Migrated both tutorial tasks into the canonical `agentbench-live` benchmark pack with versioned benchmark/agent/task manifests, byte-preserved prompts, and the Same Stats seed fixture. Added `BenchmarkCatalog` discovery and asynchronous lookup/list APIs, including compatibility projection to the existing synchronous `TaskManifest` and `AgentConfig` contracts. Added cross-pack benchmark/task/agent collision checks. The legacy synchronous registry remains operational and now exposes `legacyTasks` for the migration boundary.

## TDD evidence

RED command:

```text
pnpm exec vitest run tests/benchmarks/tutorials.test.ts
```

Result: failed suite before implementation because `@/core/benchmarks/catalog` did not exist (`Failed to resolve import ... Does the file exist?`). This was the expected migration RED.

GREEN command:

```text
pnpm exec vitest run tests/benchmarks/tutorials.test.ts tests/benchmarks/loader.test.ts tests/core/domain.test.ts tests/verifiers
```

Result: `Test Files 5 passed (5); Tests 33 passed (33)`.

## Verification

- `pnpm exec vitest run`: `Test Files 26 passed (26); Tests 150 passed | 1 skipped (151)`.
- `pnpm exec next typegen`: successful.
- `pnpm exec tsc --noEmit`: successful.
- `pnpm exec next build`: successful production build.

## Files changed

- `agentbench-live/benchmarks/tutorials/agentbench-live/benchmark.yaml`
- `agentbench-live/benchmarks/tutorials/agentbench-live/agents.yaml`
- Tutorial task manifests, prompts, and `same-stats-different-graph/fixtures/seed.csv`
- `agentbench-live/src/core/benchmarks/catalog.ts`
- `agentbench-live/src/core/tasks/registry.ts`
- `agentbench-live/tests/benchmarks/tutorials.test.ts`

## Self-review and concerns

The catalog deliberately does not replace synchronous runtime resolution; that remains Task 5 work per the progress ruling. `.snapshots/` was generated during tests and is intentionally not part of the commit.

## Fix round 1: raw prompt byte fidelity

RED command:

```text
pnpm exec vitest run tests/benchmarks/tutorials.test.ts
```

Result: `1 failed` because the raw URL Shortener prompt had an extra terminal newline (`expected ... result.\n to be ... result.`). The new assertions compare both prompt files directly to the legacy constants and assert no terminal newline.

Fix: removed terminal newlines from both canonical prompt files and removed catalog prompt normalization, so loaded prompts are now direct file contents.

GREEN command:

```text
pnpm exec vitest run tests/benchmarks/tutorials.test.ts tests/benchmarks/loader.test.ts tests/core/domain.test.ts tests/verifiers
```

Result: `Test Files 5 passed (5); Tests 33 passed (33)`.
