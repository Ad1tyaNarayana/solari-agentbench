# Task 2 implementation report

## Scope

Implemented path-safe benchmark pack loading and immutable content-addressed snapshots.

- `resolvePackFile` / `resolvePackDirectory` reject traversal, absolute paths, NUL bytes, missing paths, directories (for files), and escaping symlinks.
- `BenchmarkLoader` parses canonical `benchmark.yaml`, `agents.yaml`, task roots, prompts, fixtures, evaluator local assets/rubrics, detects duplicate task IDs, and returns sorted normalized definitions.
- `createBenchmarkSnapshot` canonicalizes paths, hashes path/content framing, copies semantic bytes into an atomic digest directory, reuses verified manifests, and returns frozen metadata.

## TDD evidence

RED command (before implementation):

`pnpm --dir agentbench-live test -- tests/benchmarks/loader.test.ts tests/benchmarks/snapshot.test.ts`

Result: failed because `@/core/benchmarks/loader` and `@/core/benchmarks/snapshot` did not exist. The command also ran the repository suite due the package-script argument forwarding and exposed one pre-existing/flaky orchestrator failure (`lateProvisionKills` expected 1, received 0). An initial exploratory invocation with unsupported Vitest `--runInBand` was discarded.

GREEN focused command:

`pnpm --dir agentbench-live exec vitest run tests/benchmarks/loader.test.ts tests/benchmarks/snapshot.test.ts`

Result: 2 files passed, 10 tests passed.

## Verification

- `pnpm --dir agentbench-live exec vitest run tests/benchmarks tests/core/security.test.ts`: 4 files, 38 tests passed.
- `pnpm --dir agentbench-live test`: 25 files, 136 tests passed, 1 skipped.
- `pnpm --dir agentbench-live exec next typegen`: passed.
- `pnpm --dir agentbench-live exec tsc --noEmit`: passed.

## Files changed

- `agentbench-live/src/core/benchmarks/paths.ts`
- `agentbench-live/src/core/benchmarks/snapshot.ts`
- `agentbench-live/src/core/benchmarks/loader.ts`
- `agentbench-live/tests/benchmarks/loader.test.ts`
- `agentbench-live/tests/benchmarks/snapshot.test.ts`

## Self-review

Reviewed the diff for scope, deterministic ordering, symlink containment, duplicate IDs, missing assets, snapshot source immutability, atomic temporary directories, and manifest verification. No concerns remain within Task 2 scope.

## Commit

Commit created after verification; pre-final-report commit hash: `508bf16954a92a386071f637beb5c3df7559ff39`.

## Fix Round 1/5

### Findings addressed

1. Evaluator asset discovery is now explicit and evaluator-config scoped: `schema`, `rubric`, `script`, `expected`, and `fixture` keys are treated as local assets; command arrays recognize path arguments including basename scripts such as `verify.py`. Submission `subject` and arbitrary strings are not guessed as pack assets.
2. Task-folder discovery resolves every directory entry through the containment helper, including symlinked directories, and rejects external junctions/symlinks instead of silently omitting them.
3. Existing digest directories are reused only after manifest equality and per-file existence, size, and SHA-256 verification.

### TDD evidence

RED: `pnpm --dir agentbench-live exec vitest run tests/benchmarks/loader.test.ts tests/benchmarks/snapshot.test.ts`

Result: 3 expected failures in the new regressions: evaluator basename assets were absent from the snapshot, an external task-directory symlink was silently omitted, and tampered snapshot content was accepted (13 total tests, 3 failed, 10 passed).

GREEN: same command after implementation — 2 files passed, 13 tests passed.

### Covering verification

- `pnpm --dir agentbench-live exec vitest run tests/benchmarks tests/core/security.test.ts`: 4 files, 41 tests passed.
- `pnpm --dir agentbench-live test`: 25 files, 139 tests passed, 1 skipped.
- `pnpm --dir agentbench-live exec next typegen`: passed.
- `pnpm --dir agentbench-live exec tsc --noEmit`: passed.

### Files changed

- `agentbench-live/src/core/benchmarks/loader.ts`
- `agentbench-live/src/core/benchmarks/snapshot.ts`
- `agentbench-live/tests/benchmarks/loader.test.ts`
- `agentbench-live/tests/benchmarks/snapshot.test.ts`

### Concerns

No remaining concerns within Task 2 scope. The explicit evaluator asset-key contract intentionally avoids treating arbitrary evaluator configuration strings as files.

Fix implementation commit: `c8a0fad5c816b444d7b6af393a7f991f97d6ff79` (`fix(agentbench): harden benchmark asset loading`).
