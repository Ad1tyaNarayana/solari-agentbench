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

## Fix Round 2/5

### Findings addressed

- Evaluator asset extraction is now dispatched by `evaluator.type`; schema uses `config.schema`, model-judge uses `config.rubric`, and command uses recognized path-bearing command arguments plus explicitly supported `expected`/`script`/`fixture` keys. Unrelated evaluator types do not resolve same-named keys.
- All task-root entries, including symlinked directories, are resolved through containment validation; escaping task-directory links are rejected.
- Existing snapshots are recursively enumerated and must contain exactly `manifest.json` plus declared semantic files; every declared file is checked for size and SHA-256.
- Snapshot publication attempts atomic rename first and handles `EEXIST`/`EPERM`/`ENOTEMPTY` collisions by verifying and reusing the winner, supporting concurrent identical loads without TOCTOU access checks or leaked temporary directories.

### TDD evidence

RED: `pnpm --dir agentbench-live exec vitest run tests/benchmarks/loader.test.ts tests/benchmarks/snapshot.test.ts`

Result: 3 expected regression failures (asset-looking key on unrelated type was incorrectly loaded, injected extra file was accepted, and concurrent identical creation threw a rename collision); 13 passed and 3 failed.

GREEN: same command after implementation — 2 files passed, 16 tests passed.

### Covering verification

- `pnpm --dir agentbench-live exec vitest run tests/benchmarks tests/core/security.test.ts`: 4 files, 44 tests passed.
- `pnpm --dir agentbench-live test`: 25 files, 142 tests passed, 1 skipped.
- `pnpm --dir agentbench-live exec next typegen`: passed.
- `pnpm --dir agentbench-live exec tsc --noEmit`: passed.

### Files changed

- `agentbench-live/src/core/benchmarks/loader.ts`
- `agentbench-live/src/core/benchmarks/snapshot.ts`
- `agentbench-live/tests/benchmarks/loader.test.ts`
- `agentbench-live/tests/benchmarks/snapshot.test.ts`

Fix implementation commit: `46b97342d96b7a694728beb13267f6bef7575de5` (`fix(agentbench): make loader assets type-specific`).

## Fix Round 3/5

### Findings addressed

Replaced shared/global evaluator config recursion with exact evaluator-type dispatch: schema extracts only `config.schema`; model-judge only `config.rubric`; command extracts recognized path-bearing `config.command` arguments and explicitly supported `config.script`, `config.expected`, and `config.fixture`. Added negative regressions proving schema `script` and model-judge `schema` are ignored, while canonical command assets remain positive.

### TDD evidence

RED: `pnpm --dir agentbench-live exec vitest run tests/benchmarks/loader.test.ts tests/benchmarks/snapshot.test.ts` — 2 expected failures (schema `script` and model-judge `schema` were incorrectly loaded), 16 passed.

GREEN: same command — 2 files passed, 18 tests passed.

### Covering verification

- `pnpm --dir agentbench-live exec vitest run tests/benchmarks tests/core/security.test.ts`: 4 files, 46 tests passed.
- `pnpm --dir agentbench-live test`: 25 files, 144 tests passed, 1 skipped.
- `pnpm --dir agentbench-live exec next typegen`: passed.
- `pnpm --dir agentbench-live exec tsc --noEmit`: passed.

### Files changed

- `agentbench-live/src/core/benchmarks/loader.ts`
- `agentbench-live/tests/benchmarks/loader.test.ts`

Fix implementation commit: `d3d7a139b1bf80797170778a451c819673c82e04` (`fix(agentbench): scope evaluator assets by type`).

## Fix Round 4/5

### Finding addressed

Added positive regression coverage proving successful benchmark loading and exact semantic snapshot inclusion for each previously uncovered evaluator asset declaration:

- schema evaluator `config.schema`;
- model-judge evaluator `config.rubric`;
- command evaluator `config.script`;
- command evaluator `config.fixture`.

The existing positive command-argv-basename and `config.expected` assertions, plus all cross-type negative assertions, remain unchanged. Each new test also asserts the normalized evaluator configuration so the load-success boundary and snapshot-copy boundary are both covered.

### TDD / characterization evidence

The tests were added before any production change. The requested initial command was attempted exactly as specified:

`npm test -- tests/benchmarks/loader.test.ts tests/benchmarks/snapshot.test.ts`

Result: command could not start (exit 1) because `npm` was not available on this shell's `PATH`:

```text
npm: The term 'npm' is not recognized as a name of a cmdlet, function, script file, or executable program.
```

The repository's available `pnpm` shim was then attempted:

`pnpm --dir agentbench-live exec vitest run tests/benchmarks/loader.test.ts tests/benchmarks/snapshot.test.ts`

Result: command could not start (exit 1) until the bundled Node runtime was placed on `PATH`:

```text
'node' is not recognized as an internal or external command,
operable program or batch file.
```

After resolving the Codex bundled workspace dependencies, all verification commands below used this exact prelude:

`$env:PATH = 'C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback;' + $env:PATH`

Test-first characterization command:

`pnpm --dir agentbench-live exec vitest run tests/benchmarks/loader.test.ts tests/benchmarks/snapshot.test.ts`

Result: 2 test files passed, 22 tests passed. The four new tests passed immediately because Fix Round 3 already implemented the exact per-evaluator dispatch. This round therefore closes the reported assertion/coverage gap rather than an implementation failure; no RED production failure was fabricated and no production code was changed.

### Covering verification

- `pnpm --dir agentbench-live exec vitest run tests/benchmarks tests/core/security.test.ts`
  - Exit 0: 4 test files passed, 50 tests passed.
- `pnpm --dir agentbench-live test`
  - Exit 0: 25 test files passed, 148 tests passed, 1 skipped (149 total).
- `pnpm --dir agentbench-live exec next typegen`
  - Exit 0: `Generating route types...` / `Types generated successfully`.
- `pnpm --dir agentbench-live exec tsc --noEmit`
  - Exit 0 with no output.
- `git diff --check`
  - Exit 0; only Git's existing LF-to-CRLF working-copy notice was emitted.

### Files changed

- `agentbench-live/tests/benchmarks/loader.test.ts`

No production files changed.

### Self-review

Reviewed the final test diff against the open finding and binding spec. Each test uses a real temporary benchmark pack and real snapshot filesystem bytes, contains literal expected values, and would fail if its corresponding evaluator-type/key dispatch were removed. Existing positive and negative asset-dispatch coverage remains intact. No concerns remain within Task 2 scope.

Fix coverage commit: `0415496` (`test(agentbench): cover evaluator snapshot assets`).
