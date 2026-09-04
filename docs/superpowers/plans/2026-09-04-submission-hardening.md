# AgentBench Live Submission Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden AgentBench Live’s evaluator trust boundary, make model-judge authority explicit, prove Studio uses the production path, and ship a live-certifiable external Raft paper-reproduction pack.

**Architecture:** Extend the canonical task schema with an evaluation policy, add graph-wide evaluator finalizers so command inputs can be sealed until every dependent evaluator finishes, and expose evaluator-owned result directories without giving submitted code network access. A certification service will load an external pack, package a reference submission, run the existing `EvaluationEngine`, require live Solari provenance plus successful cleanup, and emit a redacted canonical certificate.

**Tech Stack:** TypeScript 5, Node.js 20+, Zod 4, Vitest 4, React 19, Next.js 16, YAML, Solari browser/sandbox SDKs, dependency-free Node.js scripts for the Raft reference implementation and evaluator.

**Spec:** `docs/superpowers/specs/2026-09-04-submission-hardening-design.md`

## Global Constraints

- Keep AgentBench Live a trusted self-hosted operator tool; do not add hosted identity, tenants, remote secret custody, or billing.
- Planning remains tool-free; Solari tools are attached only after a valid `RunPlan`.
- `/benchmark` and `/submission` must be permission-hardened and byte/path/length sealed until the complete evaluator graph finishes.
- Input mutation is an evaluator infrastructure error and forces `invalid-score` with `score: null`.
- Model-judge weight defaults to a maximum of 30 points and cannot become a majority unless the task explicitly opts in.
- The two bundled tutorial tasks remain 100% deterministic with zero model-judge points.
- Raft evaluation is deterministic, trace-derived, and runs submitted code with network disabled.
- Live certification requires observed Solari sandbox and browser creation plus successful cleanup; fake services and validate-only runs cannot produce a public certificate.
- Preserve structured credential redaction before hashing or persistence.
- Follow `agentbench-live/AGENTS.md`; before editing Next.js UI, read the relevant local Next.js 16 guides under `agentbench-live/node_modules/next/dist/docs/`.

---

### Task 1: Canonical model-judge authority policy

**Files:**
- Modify: `agentbench-live/src/core/benchmarks/types.ts`
- Modify: `agentbench-live/src/core/benchmarks/schema.ts`
- Modify: `agentbench-live/src/core/domain/task.ts`
- Modify: `agentbench-live/src/core/benchmarks/catalog.ts`
- Modify: `agentbench-live/src/core/authoring/types.ts`
- Modify: `agentbench-live/src/core/authoring/render.ts`
- Modify: `agentbench-live/src/core/authoring/service.ts`
- Modify: `agentbench-live/src/components/studio/use-benchmark-draft.ts`
- Test: `agentbench-live/tests/benchmarks/schema.test.ts`
- Test: `agentbench-live/tests/authoring/render.test.ts`

**Interfaces:**
- Produces: `EvaluationPolicy = { maxModelJudgeWeight: number; allowModelJudgeMajority: boolean }`.
- Produces: `DEFAULT_EVALUATION_POLICY` with `{ maxModelJudgeWeight: 30, allowModelJudgeMajority: false }`.
- Produces: `BenchmarkTaskDefinition.evaluationPolicy` and `TaskManifest.evaluationPolicy` as normalized, required in-memory values.
- Consumes: enabled evaluator declarations after the existing total-weight validation.

- [ ] **Step 1: Write failing schema tests for 0, 30, 31, and 100 model-judge points**

```ts
function taskWithJudgeWeight(weight: number) {
  return {
    ...valid,
    evaluators: [
      { id: "deterministic", type: "file", weight: 100 - weight, enabled: true, prerequisites: [], config: { subject: "results.json", assertion: "present" } },
      { id: "judge", type: "model-judge", weight, enabled: true, prerequisites: [], config: { provider: "codex", rubric: "rubric.md", inputs: ["results.json"], sampling: {} } },
    ],
  };
}

it.each([0, 30])("accepts %i model-judge points under the default policy", (weight) => {
  expect(() => parseTaskFile(taskWithJudgeWeight(weight))).not.toThrow();
});

it.each([31, 100])("rejects %i model-judge points without explicit opt-in", (weight) => {
  expect(() => parseTaskFile(taskWithJudgeWeight(weight))).toThrow(/model-judge.*30/i);
});

it("accepts a model-judge majority only with explicit opt-in", () => {
  expect(parseTaskFile({
    ...taskWithJudgeWeight(100),
    evaluationPolicy: { maxModelJudgeWeight: 100, allowModelJudgeMajority: true },
  }).evaluationPolicy).toEqual({ maxModelJudgeWeight: 100, allowModelJudgeMajority: true });
});
```

- [ ] **Step 2: Run the schema tests and verify the new cases fail because the policy is not parsed**

Run: `npm test -- tests/benchmarks/schema.test.ts`

Expected: FAIL because `evaluationPolicy` is unrecognized or overweight model judges are accepted.

- [ ] **Step 3: Add the policy schema and semantic validation**

```ts
export const DEFAULT_EVALUATION_POLICY: EvaluationPolicy = {
  maxModelJudgeWeight: 30,
  allowModelJudgeMajority: false,
};

function validateModelJudgeAuthority(
  evaluators: EvaluatorDefinition[],
  policy: EvaluationPolicy,
): void {
  const weight = evaluators
    .filter((item) => item.enabled && item.type === "model-judge")
    .reduce((sum, item) => sum + item.weight, 0);
  if (weight > policy.maxModelJudgeWeight || (weight > 50 && !policy.allowModelJudgeMajority)) {
    throw new BenchmarkValidationError([{
      path: "evaluationPolicy",
      code: "model_judge_authority",
      message: `enabled model-judge weight ${weight} exceeds the allowed ${policy.maxModelJudgeWeight}`,
    }]);
  }
}
```

Normalize omitted policy values in `taskResult`, and copy the normalized object through the catalog projection.

- [ ] **Step 4: Write failing authoring round-trip tests**

```ts
test("renders and reloads canonical evaluation policy", async () => {
  const judged = structuredClone(draft);
  judged.tasks[0].evaluationPolicy = {
    maxModelJudgeWeight: 100,
    allowModelJudgeMajority: true,
  };
  const taskYaml = renderBenchmark(judged).find((file) => file.path.endsWith("task.yaml"))!.contents;
  expect(taskYaml).toContain("allowModelJudgeMajority: true");
});
```

- [ ] **Step 5: Run the authoring tests and verify the policy is missing**

Run: `npm test -- tests/authoring/render.test.ts tests/authoring/service.test.ts`

Expected: FAIL because render/read does not preserve `evaluationPolicy`.

- [ ] **Step 6: Preserve the policy through draft render, save, reload, and initial Studio state**

Render `evaluationPolicy` beside `evaluators` in `task.yaml`, include it in `BenchmarkDraftTask`, and copy it in `AuthoringService.readDraft`. Give the initial Studio task a copy of `DEFAULT_EVALUATION_POLICY`.

- [ ] **Step 7: Run focused tests and commit**

Run: `npm test -- tests/benchmarks/schema.test.ts tests/authoring/render.test.ts tests/authoring/service.test.ts tests/benchmarks/loader.test.ts`

Expected: PASS.

```bash
git add agentbench-live/src/core/benchmarks agentbench-live/src/core/domain/task.ts agentbench-live/src/core/authoring agentbench-live/src/components/studio/use-benchmark-draft.ts agentbench-live/tests/benchmarks agentbench-live/tests/authoring
git commit -m "feat(agentbench): bound model judge authority"
```

---

### Task 2: Studio authority warning and score split

**Files:**
- Modify: `agentbench-live/src/components/studio/studio-shell.tsx`
- Modify: `agentbench-live/src/components/studio/studio.module.css`
- Modify: `agentbench-live/src/components/studio/use-benchmark-draft.ts`
- Test: `agentbench-live/tests/app/studio.test.tsx`

**Interfaces:**
- Consumes: `BenchmarkDraftTask.evaluationPolicy` from Task 1.
- Produces: deterministic/model-judge totals in the Evaluators and Review steps.
- Produces: an explicit majority opt-in control and an unavoidable warning when enabled model-judge weight exceeds 50.
- Produces: optional `StudioShell({ initialDraft })` test/demo injection, passed into `useBenchmarkDraft(initialDraft)`, while production callers retain the canonical default.

- [ ] **Step 1: Read the local Next.js component and accessibility guidance**

Run: `Get-Content -Raw node_modules/next/dist/docs/01-app/03-building-your-application/03-rendering/01-server-components.md; Get-Content -Raw node_modules/next/dist/docs/03-architecture/accessibility.md`

Expected: local Next.js 16 guidance is available before component edits.

- [ ] **Step 2: Write failing UI tests for the split and opt-in warning**

```tsx
test("shows deterministic and model-judge weights separately", () => {
  render(<StudioShell />);
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  expect(screen.getByText(/deterministic weight/i)).toHaveTextContent("100");
  expect(screen.getByText(/model-judge weight/i)).toHaveTextContent("0");
});

test("requires an explicit warning-bearing opt-in for a model-judge majority", () => {
  render(<StudioShell initialDraft={majorityJudgeDraft} />);
  expect(screen.getByRole("alert")).toHaveTextContent(/subjective.*majority/i);
  expect(screen.getByRole("checkbox", { name: /allow model-judge majority/i })).not.toBeChecked();
});
```

- [ ] **Step 3: Run the Studio tests and verify the new labels and control are absent**

Run: `npm test -- tests/app/studio.test.tsx`

Expected: FAIL on missing split labels/opt-in control.

- [ ] **Step 4: Implement task-level policy controls and launch gating**

Compute enabled deterministic and model-judge weights once for the active task. Display both values in Evaluators and Review. Bind the checkbox to `evaluationPolicy.allowModelJudgeMajority`; when checked, set `maxModelJudgeWeight` to at least the current judge weight. Keep save/run invalid while the current judge weight exceeds the configured maximum or exceeds 50 without opt-in. Accept an optional initial draft in `StudioShell` and `useBenchmarkDraft` so the warning state is directly testable without changing production defaults.

- [ ] **Step 5: Run UI tests and commit**

Run: `npm test -- tests/app/studio.test.tsx tests/authoring/render.test.ts`

Expected: PASS.

```bash
git add agentbench-live/src/components/studio agentbench-live/tests/app/studio.test.tsx
git commit -m "feat(agentbench): surface judge authority in studio"
```

---

### Task 3: Sealed evaluator input manifests and graph-wide finalizers

**Files:**
- Create: `agentbench-live/src/core/evaluators/input-seal.ts`
- Modify: `agentbench-live/src/core/evaluators/types.ts`
- Modify: `agentbench-live/src/core/evaluators/runtime.ts`
- Modify: `agentbench-live/src/core/evaluators/pipeline.ts`
- Modify: `agentbench-live/src/core/evaluators/command.ts`
- Test: `agentbench-live/tests/evaluators/input-seal.test.ts`
- Test: `agentbench-live/tests/evaluators/runtime.test.ts`
- Test: `agentbench-live/tests/evaluators/pipeline.test.ts`
- Test: `agentbench-live/tests/evaluators/command.test.ts`
- Test: `agentbench-live/tests/evaluators/scoring.test.ts`

**Interfaces:**
- Produces: `InputSealManifest = { schemaVersion: 1; files: Array<{ path: string; size: number; digest: string }> }`.
- Produces: `buildInputSeal(snapshot, submission): InputSealManifest`.
- Produces: `verifyInputSeal(sandbox, manifest): Promise<InputSealReport>`.
- Produces: `EvaluatorResourcePort.registerFinalizer(evaluatorId, callback)` and `runFinalizers()`.
- Produces: `EvaluatorFinalizerOutcome` carrying status, summary, assertions, evidence, and metadata to merge into the owning evaluator result.

- [ ] **Step 1: Write failing pure manifest tests for stable ordering and byte changes**

```ts
test("builds a canonical path-size-digest manifest", () => {
  expect(buildInputSeal(snapshot, submission).files.map((file) => file.path)).toEqual([
    "/benchmark/prompt.md",
    "/submission/app.js",
  ]);
});

test("reports added, deleted, and changed files", async () => {
  const report = await verifyInputSeal(fakeSandboxTree({
    "/submission/app.js": "changed",
    "/submission/extra.txt": "new",
  }), manifest);
  expect(report).toMatchObject({ ok: false, added: ["/submission/extra.txt"], deleted: [], changed: ["/submission/app.js"] });
});
```

- [ ] **Step 2: Run the seal tests and verify the module does not exist**

Run: `npm test -- tests/evaluators/input-seal.test.ts`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement canonical manifest creation and sandbox verification**

Use Node’s `createHash("sha256")` over snapshot bytes and submission entry bytes. Enumerate sandbox paths with the fixed, non-interpolated command below, split NUL-delimited output, then call `sandbox.readFile` for each returned path:

```ts
const listed = await sandbox.exec("find", ["/benchmark", "/submission", "-type", "f", "-print0"]);
const paths = listed.stdout.split("\0").filter(Boolean).sort(compareUtf8Bytes);
```

Fail closed when `find`, reading, or hashing fails. Do not place file contents in the report.

- [ ] **Step 4: Write failing runtime and pipeline tests for post-graph finalization**

```ts
test("runs finalizers after dependent browser evaluation", async () => {
  const order: string[] = [];
  resources.registerFinalizer("serve", async () => {
    order.push("finalize");
    return passingFinalizerOutcome;
  });
  await pipeline.run(context, definitions);
  expect(order).toEqual(["command", "browser", "finalize"]);
});

test("turns finalizer failure into an invalid score owned by the command evaluator", async () => {
  const report = await pipeline.run(contextWithFailingFinalizer, definitions);
  expect(report).toMatchObject({ status: "invalid-score", score: null });
  expect(report.results[0]).toMatchObject({ evaluatorId: "serve", status: "error", earnedPoints: 0 });
});
```

- [ ] **Step 5: Run runtime/pipeline tests and verify finalizer methods are missing**

Run: `npm test -- tests/evaluators/runtime.test.ts tests/evaluators/pipeline.test.ts tests/evaluators/scoring.test.ts`

Expected: FAIL on missing finalizer APIs or unchanged valid score.

- [ ] **Step 6: Implement ordered, idempotent finalizers and result merging**

`EvaluatorRuntime` stores callbacks in registration order and executes them once. `EvaluatorPipeline` runs all finalizers after the graph, merges passing finalizer evidence/metadata into the owner, and replaces the owner with `status: "error"`, zero points, a redacted summary, and integrity evidence on failure. Recompute the report with `scoreEvaluation` only after merging.

- [ ] **Step 7: Write failing command tests for chmod, foreground tampering, and background tampering**

```ts
expect(sandbox.exec).toHaveBeenCalledWith("chmod", ["-R", "a-w", "/benchmark", "/submission"], expect.anything());
expect(resources.registerFinalizer).toHaveBeenCalledWith("cmd", expect.any(Function));
```

Exercise changed, added, and deleted files plus a finalizer enumeration error. The background case must mutate after health succeeds and before the pipeline calls finalizers.

- [ ] **Step 8: Run command tests and verify the seal is not installed**

Run: `npm test -- tests/evaluators/command.test.ts tests/evaluators/input-seal.test.ts`

Expected: FAIL because inputs remain writable and no finalizer is registered.

- [ ] **Step 9: Seal every command evaluator after upload and before submitted code runs**

Create the expected manifest before upload, upload both trees, call `chmod -R a-w`, register an integrity finalizer that writes `application/json` evidence with role `input-integrity`, and only then run the network-isolation probe and evaluator command. A chmod or seal error must throw before submitted code runs.

- [ ] **Step 10: Run focused evaluator tests and commit**

Run: `npm test -- tests/evaluators/input-seal.test.ts tests/evaluators/runtime.test.ts tests/evaluators/pipeline.test.ts tests/evaluators/command.test.ts tests/evaluators/scoring.test.ts`

Expected: PASS.

```bash
git add agentbench-live/src/core/evaluators agentbench-live/tests/evaluators
git commit -m "feat(agentbench): seal evaluator input trees"
```

---

### Task 4: Network-isolated result previews and dynamic browser assertions

**Files:**
- Modify: `agentbench-live/src/core/evaluators/command.ts`
- Modify: `agentbench-live/src/core/evaluators/browser.ts`
- Test: `agentbench-live/tests/evaluators/command.test.ts`
- Test: `agentbench-live/tests/evaluators/browser.test.ts`

**Interfaces:**
- Produces: optional command config `resultPreview: { directory: string; port: number; healthPath?: string }` restricted to `/result` descendants.
- Produces: foreground command output `previewUrl` after an evaluator-owned static server starts outside the submitted process’s network namespace.
- Extends: browser `assertText.contains` from `string` to the existing `Value` union.

- [ ] **Step 1: Write a failing command test proving preview serving follows isolated execution**

```ts
test("serves only evaluator result output after a network-isolated command exits", async () => {
  const outcome = await command.evaluate(definition({
    argv: ["node", "/benchmark/verify.mjs"],
    network: false,
    resultPreview: { directory: "/result/viewer", port: 4173, healthPath: "/index.html" },
  }), context, signal);
  expect(sandbox.exec.mock.calls[1][0]).toBe("unshare");
  expect(sandbox.start).toHaveBeenCalledWith("python3", ["-m", "http.server", "4173", "--directory", "/result/viewer"], expect.anything());
  expect(outcome.outputs.previewUrl).toBe("https://preview.test");
});
```

- [ ] **Step 2: Run the command test and verify `resultPreview` is rejected**

Run: `npm test -- tests/evaluators/command.test.ts`

Expected: FAIL from strict config validation.

- [ ] **Step 3: Implement fixed-command result serving and reuse the health probe**

Require an absolute normalized directory equal to `/result` or beginning `/result/`. Start only the fixed Python HTTP server command; never accept a server argv from benchmark or submission data. Merge `previewUrl` into parsed evaluator outputs after successful health check. Leave legacy `background` behavior unchanged.

- [ ] **Step 4: Write a failing browser test for evaluator-referenced expected text**

```ts
const action = {
  type: "assertText",
  selector: "[data-term]",
  contains: { fromEvaluator: "verify", output: "expectedTerm" },
};
expect(result.assertions[0]).toMatchObject({ passed: true, expected: "3" });
```

- [ ] **Step 5: Run the browser test and verify object-valued `contains` is rejected**

Run: `npm test -- tests/evaluators/browser.test.ts`

Expected: FAIL from browser config validation.

- [ ] **Step 6: Resolve dynamic `assertText.contains` through `resolveValue`**

Reject non-string resolved values with a typed evaluator error, then compare the resolved string to `page.textContent` and store the resolved value in the assertion.

- [ ] **Step 7: Run focused tests and commit**

Run: `npm test -- tests/evaluators/command.test.ts tests/evaluators/browser.test.ts tests/evaluators/pipeline.test.ts`

Expected: PASS.

```bash
git add agentbench-live/src/core/evaluators/command.ts agentbench-live/src/core/evaluators/browser.ts agentbench-live/tests/evaluators/command.test.ts agentbench-live/tests/evaluators/browser.test.ts
git commit -m "feat(agentbench): expose isolated result previews"
```

---

### Task 5: Live certification service and CLI

**Files:**
- Create: `agentbench-live/src/core/certification/types.ts`
- Create: `agentbench-live/src/core/certification/report.ts`
- Create: `agentbench-live/src/core/certification/service.ts`
- Modify: `agentbench-live/src/core/security/package-submission.ts`
- Modify: `agentbench-live/src/core/solari/clients.ts`
- Modify: `agentbench-live/src/core/evaluators/runtime.ts`
- Modify: `agentbench-live/src/core/evaluators/engine.ts`
- Modify: `agentbench-live/src/cli.ts`
- Test: `agentbench-live/tests/certification/report.test.ts`
- Test: `agentbench-live/tests/certification/service.test.ts`
- Test: `agentbench-live/tests/integration/cli.test.ts`
- Test: `agentbench-live/tests/core/security.test.ts`

**Interfaces:**
- Produces: `packageSubmissionDirectory(directory, policy): Promise<SubmissionPackage>`; existing workspace packaging delegates to it.
- Produces: `EvaluationResourceAudit = { created: { browsers: string[]; sandboxes: string[]; desktops: string[] }; cleanupIssues: CleanupIssue[] }` on `EvaluationEngineResult`.
- Produces: `isLiveSolariServices(services): boolean`, backed by a module-private `WeakSet` populated only by `createSolariServices` with a non-empty API key.
- Produces: `CertificationService.validate(input)` and `CertificationService.certify(input)`.
- Produces: CLI `certify --benchmark-root <path> --submission <path> --output <path> [--task <id>] [--validate-only]`.

- [ ] **Step 1: Write a failing packaging test for an explicit submission directory**

```ts
const packaged = await packageSubmissionDirectory(join(root, "candidate"), defaultSubmissionPolicy);
expect(packaged.entries).toHaveProperty("results.json");
```

- [ ] **Step 2: Run the security test and verify the API is missing**

Run: `npm test -- tests/core/security.test.ts`

Expected: FAIL with missing export.

- [ ] **Step 3: Extract directory packaging without weakening traversal or secret checks**

Keep `packageSubmission(workspace, policy)` as a compatibility wrapper around `packageSubmissionDirectory(resolve(workspace.root, "submission"), policy)`. Preserve byte limits, denied directories, symlink rejection, binary validation, `results.json`, and digest semantics exactly.

- [ ] **Step 4: Write failing engine audit and live-provenance tests**

```ts
expect(result.resourceAudit.created).toEqual({ browsers: ["b1"], sandboxes: ["s1"], desktops: [] });
expect(result.resourceAudit.cleanupIssues).toEqual([]);
expect(isLiveSolariServices(fakeServices)).toBe(false);
expect(isLiveSolariServices(createSolariServices("slr_test_example", "https://example.invalid"))).toBe(true);
```

- [ ] **Step 5: Run engine/client tests and verify audit/provenance are absent**

Run: `npm test -- tests/evaluators/engine.test.ts tests/core/solari-clients.test.ts tests/evaluators/runtime.test.ts`

Expected: FAIL on missing resource audit and provenance function.

- [ ] **Step 6: Record evaluator resource creation and cleanup**

Record IDs inside `EvaluatorRuntime.acquire*`, return cleanup issues from `dispose`, and expose a sorted audit only after disposal. Restructure `EvaluationEngine.run` so it captures the report, disposes resources in `finally`, reads the final evidence manifest, and returns the audit. Do not expose API keys or service internals.

- [ ] **Step 7: Write failing certificate schema and service tests**

```ts
expect(() => service.certify(inputWithFakeServices)).rejects.toThrow(/live Solari/i);
expect(() => service.certify(inputWithNoBrowser)).rejects.toThrow(/browser/i);
expect(await service.validate(input)).toMatchObject({ valid: true, provisioned: false });
expect(existsSync(outputPath)).toBe(false);
```

Also assert stable key ordering, `agentId: null`, `provider: null`, `harness: null` for a supplied reference submission, evaluator type/version/result/evidence digests, redaction of injected Solari/bearer strings, and no output file on invalid score or cleanup failure.

- [ ] **Step 8: Run certificate tests and verify the service modules are absent**

Run: `npm test -- tests/certification/report.test.ts tests/certification/service.test.ts`

Expected: FAIL with module-not-found.

- [ ] **Step 9: Implement canonical certification reports and atomic writes**

Use schema version 1 and mode `live-reference-certification`. Select the sole task when `--task` is omitted; reject omission for multi-task packs. Validate evaluator configs before provisioning. `--validate-only` loads the pack, packages the submission, validates policy/evaluators, reports digests, and never creates or writes a certificate. `certify` requires live services, a valid score, at least one sandbox and browser ID, and zero cleanup issues. Redact the report structurally, serialize with a fixed top-level/property order and two-space indentation, then atomically rename the output file.

- [ ] **Step 10: Write failing CLI tests for argument routing and validate-only behavior**

```ts
await runCli(["certify", "--benchmark-root", pack, "--submission", submission, "--output", output], runtime);
expect(runtime.certify).toHaveBeenCalledWith({ benchmarkRoot: resolve(pack), submissionDirectory: resolve(submission), outputPath: resolve(output), taskId: undefined });

await runCli(["certify", "--benchmark-root", pack, "--submission", submission, "--validate-only"], runtime);
expect(runtime.validateCertification).toHaveBeenCalled();
```

- [ ] **Step 11: Run CLI tests and verify `certify` is unknown**

Run: `npm test -- tests/integration/cli.test.ts`

Expected: FAIL with usage error or missing runtime methods.

- [ ] **Step 12: Wire certification into the default runtime**

Resolve all three user paths, reject `--output` for validate-only and require it for live certification, reuse `BenchmarkLoader`, the builtin evaluator registry, credential store, evidence root, and Solari services. Obtain the repository commit with `git rev-parse HEAD`; fail rather than writing an untraceable certificate if it cannot be resolved.

- [ ] **Step 13: Run focused tests and commit**

Run: `npm test -- tests/certification tests/integration/cli.test.ts tests/core/security.test.ts tests/evaluators/engine.test.ts tests/core/solari-clients.test.ts`

Expected: PASS.

```bash
git add agentbench-live/src/core/certification agentbench-live/src/core/security/package-submission.ts agentbench-live/src/core/solari/clients.ts agentbench-live/src/core/evaluators agentbench-live/src/cli.ts agentbench-live/tests/certification agentbench-live/tests/integration/cli.test.ts agentbench-live/tests/core
git commit -m "feat(agentbench): add live certification command"
```

---

### Task 6: External Raft paper-reproduction pack and reference submission

**Files:**
- Create: `agentbench-live/examples/packs/raft-consensus-reproduction/benchmark.yaml`
- Create: `agentbench-live/examples/packs/raft-consensus-reproduction/agents.yaml`
- Create: `agentbench-live/examples/packs/raft-consensus-reproduction/tasks/raft-safety/prompt.md`
- Create: `agentbench-live/examples/packs/raft-consensus-reproduction/tasks/raft-safety/task.yaml`
- Create: `agentbench-live/examples/packs/raft-consensus-reproduction/tasks/raft-safety/evaluators/results.schema.json`
- Create: `agentbench-live/examples/packs/raft-consensus-reproduction/tasks/raft-safety/evaluators/verify-raft.mjs`
- Create: `agentbench-live/examples/packs/raft-consensus-reproduction/tasks/raft-safety/fixtures/stable-election.json`
- Create: `agentbench-live/examples/packs/raft-consensus-reproduction/tasks/raft-safety/fixtures/leader-failover.json`
- Create: `agentbench-live/examples/packs/raft-consensus-reproduction/tasks/raft-safety/fixtures/minority-isolation.json`
- Create: `agentbench-live/examples/packs/raft-consensus-reproduction/tasks/raft-safety/fixtures/majority-recovery.json`
- Create: `agentbench-live/examples/packs/raft-consensus-reproduction/tasks/raft-safety/fixtures/divergent-log-repair.json`
- Create: `agentbench-live/examples/packs/raft-consensus-reproduction/reference-submission/run`
- Create: `agentbench-live/examples/packs/raft-consensus-reproduction/reference-submission/source/raft.mjs`
- Create: `agentbench-live/examples/packs/raft-consensus-reproduction/reference-submission/source/viewer.mjs`
- Create: `agentbench-live/examples/packs/raft-consensus-reproduction/reference-submission/results.json`
- Create: `agentbench-live/examples/packs/raft-consensus-reproduction/reference-submission/methodology.md`
- Create: `agentbench-live/examples/packs/raft-consensus-reproduction/reference-submission/provenance.json`
- Test: `agentbench-live/tests/fixtures/raft/mutated-trace.jsonl`
- Test: `agentbench-live/tests/fixtures/raft/valid-trace.jsonl`
- Test: `agentbench-live/tests/integration/raft-pack.test.ts`

**Interfaces:**
- Consumes: command `resultPreview` and dynamic browser assertion values from Task 4.
- Produces: `run <scenario-json> <integer-seed> <output-directory>` with canonical `summary.json`, `trace.jsonl`, and `viewer/index.html`.
- Produces: verifier outputs `expectedTerm`, `expectedLeader`, `electionSafety`, `logMatching`, `leaderCompleteness`, `stateMachineSafety`, and `quorumBehavior`.

- [ ] **Step 1: Write failing loader tests for external-only discovery and zero judge weight**

```ts
const loaded = await new BenchmarkLoader(snapshots).load(raftPackRoot);
expect(loaded.definition.id).toBe("raft-consensus-reproduction");
expect(loaded.definition.tasks).toHaveLength(1);
expect(loaded.definition.tasks[0].evaluators.filter((item) => item.type === "model-judge")).toHaveLength(0);
expect(loaded.definition.tasks[0].evaluationPolicy).toEqual({ maxModelJudgeWeight: 30, allowModelJudgeMajority: false });
```

- [ ] **Step 2: Run the Raft integration test and verify the pack is absent**

Run: `npm test -- tests/integration/raft-pack.test.ts`

Expected: FAIL because the pack root does not exist.

- [ ] **Step 3: Add the canonical pack, prompt, scenarios, and deterministic evaluator graph**

Declare one task, `raft-safety`, with sandbox/browser allowed, desktop omitted, one sandbox, one browser, and a five-minute total budget. Use this exact 100-point split:

```yaml
evaluators:
  - { id: run-entry, type: file, weight: 5, config: { subject: run, assertion: present } }
  - { id: results, type: schema, weight: 5, config: { subject: results.json, schema: evaluators/results.schema.json } }
  - { id: methodology, type: file, weight: 5, config: { subject: methodology.md, assertion: min-bytes, value: 400 } }
  - id: verify-raft
    type: command
    weight: 65
    prerequisites: [run-entry, results]
    config:
      argv: [node, /benchmark/tasks/raft-safety/evaluators/verify-raft.mjs]
      network: false
      resultPreview: { directory: /result/viewer, port: 4173, healthPath: /index.html }
  - id: inspect-trace
    type: browser
    weight: 20
    prerequisites: [verify-raft]
```

The browser actions navigate to `previewUrl`, select failover and partition scenarios using stable `data-testid` selectors, assert term/leader/partition/commit/invariant text using fixed or evaluator-referenced expected values, and capture screenshots.

- [ ] **Step 4: Write failing verifier tests against valid and intentionally mutated traces**

```ts
expect(await runVerifier(validReference)).toMatchObject({ exitCode: 0 });
expect(JSON.parse(await readFile(resultFile, "utf8")).assertions.every((item: { passed: boolean }) => item.passed)).toBe(true);
expect(await runVerifier(mutatedTrace)).toMatchObject({ exitCode: 1 });
```

Mutations must independently violate election safety, log matching, leader completeness, and state-machine safety so the test proves the evaluator derives claims from trace events rather than trusting `summary.json`.

- [ ] **Step 5: Run verifier tests and verify the evaluator/reference implementation is missing**

Run: `npm test -- tests/integration/raft-pack.test.ts`

Expected: FAIL on missing scripts or outputs.

- [ ] **Step 6: Implement the deterministic five-node reference simulator**

Use a logical tick loop and a small seeded PRNG. Model follower/candidate/leader roles, monotonically increasing terms, one vote per term, randomized election deadlines, heartbeats, AppendEntries prefix checks, `nextIndex` backtracking, majority commit, node stop/restart, and bidirectional partitions. Sort node IDs, messages, and JSON object construction deterministically; terminate every scenario at its declared `maxTicks` or expected terminal condition. Do not use `Date`, timers, network calls, or external packages in canonical execution.

- [ ] **Step 7: Implement canonical traces and the static viewer**

Write one JSON object per line with `tick`, `type`, `term`, `node`, `role`, `commitIndex`, and `logDigest`; include message peer IDs and entry metadata when relevant. Serialize summaries with stable key order and final newline. Generate an HTML file with embedded escaped JSON only—no remote scripts, fonts, analytics, or network fetches—and stable selectors for scenario, term, leader, partition, commit index, and each invariant.

- [ ] **Step 8: Implement the independent verifier**

For each pinned scenario, invoke `/submission/run` twice with the same seed into separate `/result` directories, compare canonical output bytes, parse all events, derive the five invariants, compare derived values with summary claims, enforce terminal/tick bounds, and copy normalized viewer assets into `/result/viewer`. Write the standard `AGENTBENCH_RESULT` contract with one assertion per determinism/scenario/invariant check and normalized outputs for the browser evaluator.

- [ ] **Step 9: Run local pack tests and commit**

Run: `npm test -- tests/integration/raft-pack.test.ts tests/benchmarks/loader.test.ts tests/benchmarks/schema.test.ts`

Expected: PASS.

```bash
git add agentbench-live/examples/packs/raft-consensus-reproduction agentbench-live/tests/fixtures/raft agentbench-live/tests/integration/raft-pack.test.ts
git commit -m "feat(agentbench): add raft reproduction pack"
```

---

### Task 7: Production-path proof for Studio and external certification

**Files:**
- Modify: `agentbench-live/tests/integration/studio-roundtrip.test.ts`
- Modify: `agentbench-live/tests/integration/raft-pack.test.ts`
- Modify: `agentbench-live/tests/core/orchestrator.test.ts`
- Create: `agentbench-live/tests/fixtures/providers/studio-jsonl-agent.mjs`

**Interfaces:**
- Consumes: `AuthoringService`, `BenchmarkCatalog`, `AgentBenchOrchestrator`, `EvaluationEngine`, and `CertificationService` without test-only bypasses.
- Produces: proof that Studio’s saved digest is the exact digest persisted by a completed orchestrated run.
- Produces: proof that the Raft pack is found only through its external root and the reference submission reaches certification with fake services while public-certificate writing remains rejected.

- [ ] **Step 1: Replace the Studio engine-only test with a failing orchestrator test**

Create a saved pack, reload it through a catalog, run a deterministic executable JSONL provider through `AgentBenchOrchestrator`, and assert:

```ts
expect(run.stage).toBe("completed");
expect(run.benchmarkDigest).toBe(created.snapshotDigest);
expect(run.evaluationReport?.results[0].evaluatorId).toBe("result");
expect(run.evidenceManifest?.entries).toEqual(expect.any(Array));
```

- [ ] **Step 2: Run the Studio integration test and verify the old fixture cannot satisfy orchestration**

Run: `npm test -- tests/integration/studio-roundtrip.test.ts`

Expected: FAIL until provider, workspace, repository, and evaluator dependencies are wired.

- [ ] **Step 3: Implement the deterministic provider fixture and full production-path test**

The JSONL fixture returns a valid no-resource plan, writes `submission/results.json`, and emits a successful result. Use the real in-memory repository or temporary SQLite repository, real workspace packager, real catalog, real orchestrator, and real evaluation engine with fake Solari services only where the selected evaluator does not provision.

- [ ] **Step 4: Add the external-root certification integration case**

Configure the catalog/loader with only `examples/packs/raft-consensus-reproduction`; assert no tutorial tasks appear. Run validation on `reference-submission`, then use fake sandbox/browser adapters to exercise the complete certification flow and assert the service refuses to write a public certificate because `isLiveSolariServices` is false.

- [ ] **Step 5: Run production-path tests and commit**

Run: `npm test -- tests/integration/studio-roundtrip.test.ts tests/integration/raft-pack.test.ts tests/core/orchestrator.test.ts`

Expected: PASS.

```bash
git add agentbench-live/tests/integration agentbench-live/tests/core/orchestrator.test.ts agentbench-live/tests/fixtures/providers/studio-jsonl-agent.mjs
git commit -m "test(agentbench): prove studio and external pack paths"
```

---

### Task 8: Product framing, trust claims, and operator instructions

**Files:**
- Modify: `agentbench-live/README.md`
- Modify: `README.md`
- Modify: `agentbench-live/src/app/page.tsx`
- Modify: `agentbench-live/src/app/globals.css`
- Test: `agentbench-live/tests/app/smoke.test.tsx`
- Test: `agentbench-live/tests/benchmarks/tutorials.test.ts`

**Interfaces:**
- Consumes: final CLI syntax, Raft pack path, judge policy, and sealing behavior.
- Produces: a crisp audience/decision statement, accurate security wording, explicit shared Studio pipeline, tutorial scoring disclosure, and copyable PowerShell/POSIX certification commands.

- [ ] **Step 1: Read the local Next.js page guidance**

Run: `Get-Content -Raw node_modules/next/dist/docs/01-app/03-building-your-application/02-data-fetching/fetching.md; Get-Content -Raw node_modules/next/dist/docs/03-architecture/accessibility.md`

Expected: local Next.js 16 guidance is available before page edits.

- [ ] **Step 2: Write failing copy contract tests**

```ts
expect(readme).toMatch(/engineering leads.*hiring teams/i);
expect(readme).toMatch(/sealed evaluator inputs/i);
expect(readme).toMatch(/zero.*model-judge/i);
expect(readme).toContain("raft-consensus-reproduction");
expect(readme).toContain("agentbench -- certify");
expect(readme).toMatch(/Studio.*same.*snapshot.*evaluator/i);
```

Update the page smoke test to require a visible sentence describing the decision the tool supports: choosing which agent configuration can be trusted with a real workflow.

- [ ] **Step 3: Run copy tests and verify current wording is incomplete or overstated**

Run: `npm test -- tests/app/smoke.test.tsx tests/benchmarks/tutorials.test.ts`

Expected: FAIL on new product/trust wording.

- [ ] **Step 4: Update README and landing-page framing**

Lead with the user and decision. Replace “immutable `/benchmark` and `/submission` trees” with “permission-hardened, tamper-evident sealed evaluator inputs.” State that both bundled tutorial tasks are 100% deterministic and model judges contribute zero points. Explain the default 30-point cap and explicit majority opt-in. State that Studio-created and external packs use the same loader, content-addressed snapshots, orchestrator, and evaluator graph.

- [ ] **Step 5: Document the external Raft pack and certification commands**

Include the official USENIX paper page and PDF, the exact five reproduced claims, the reference-submission limitation, and both invocations:

```powershell
$env:AGENTBENCH_BENCHMARK_ROOTS = "examples/packs/raft-consensus-reproduction"
npm run agentbench -- certify --benchmark-root examples/packs/raft-consensus-reproduction --submission examples/packs/raft-consensus-reproduction/reference-submission --validate-only
npm run agentbench -- certify --benchmark-root examples/packs/raft-consensus-reproduction --submission examples/packs/raft-consensus-reproduction/reference-submission --output examples/packs/raft-consensus-reproduction/certification/live-reference.json
```

```bash
export AGENTBENCH_BENCHMARK_ROOTS="examples/packs/raft-consensus-reproduction"
npm run agentbench -- certify --benchmark-root examples/packs/raft-consensus-reproduction --submission examples/packs/raft-consensus-reproduction/reference-submission --validate-only
npm run agentbench -- certify --benchmark-root examples/packs/raft-consensus-reproduction --submission examples/packs/raft-consensus-reproduction/reference-submission --output examples/packs/raft-consensus-reproduction/certification/live-reference.json
```

- [ ] **Step 6: Run copy/UI tests and commit**

Run: `npm test -- tests/app/smoke.test.tsx tests/benchmarks/tutorials.test.ts`

Expected: PASS.

```bash
git add agentbench-live/README.md README.md agentbench-live/src/app/page.tsx agentbench-live/src/app/globals.css agentbench-live/tests/app/smoke.test.tsx agentbench-live/tests/benchmarks/tutorials.test.ts
git commit -m "docs(agentbench): sharpen product and trust framing"
```

---

### Task 9: Live reference certification and release gate

**Files:**
- Create after a real successful run: `agentbench-live/examples/packs/raft-consensus-reproduction/certification/live-reference.json`
- Modify if required by observed live incompatibility: only files already named in Tasks 3–6, with a new failing regression test first.

**Interfaces:**
- Consumes: configured `SOLARI_API_KEY`, live Solari sandbox/browser services, committed Raft pack and reference submission.
- Produces: a redacted `live-reference-certification` artifact tied to the repository commit and exact benchmark/submission digests.

- [ ] **Step 1: Run validate-only without provisioning**

Run: `npm run agentbench -- certify --benchmark-root examples/packs/raft-consensus-reproduction --submission examples/packs/raft-consensus-reproduction/reference-submission --validate-only`

Expected: JSON reports `valid: true`, `provisioned: false`, and no certificate file is created.

- [ ] **Step 2: Run the live reference certification once**

Run: `npm run agentbench -- certify --benchmark-root examples/packs/raft-consensus-reproduction --submission examples/packs/raft-consensus-reproduction/reference-submission --output examples/packs/raft-consensus-reproduction/certification/live-reference.json`

Expected: score 100, `solariLive: true`, at least one sandbox and one browser in the resource audit, zero cleanup issues, and a browser replay evidence reference. Do not retry an insufficient-credit result until credit is available.

- [ ] **Step 3: Verify the committed certificate contract and secret absence**

Run: `npm test -- tests/certification tests/integration/raft-pack.test.ts`

Run: `rg -n "slr_(live|test)_|Authorization\\s*:\\s*Bearer|SOLARI_API_KEY\\s*=" examples/packs/raft-consensus-reproduction/certification/live-reference.json`

Expected: tests PASS and `rg` returns no matches.

- [ ] **Step 4: Run the complete release gate**

Run: `npm run schema:generate`

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run lint -- --max-warnings=0`

Run: `npm run build`

Run from repository root: `git diff --check`

Run with `SOLARI_API_KEY` temporarily unset in the process environment: `npm run agentbench -- smoke`

Expected: generated schema has no diff, all tests/typecheck/lint/build pass, `git diff --check` is clean, and smoke returns typed `missing_credential` with `provisioned: false`.

- [ ] **Step 5: Commit the verified live artifact**

```bash
git add agentbench-live/examples/packs/raft-consensus-reproduction/certification/live-reference.json
git commit -m "docs(agentbench): publish raft live certification"
```

- [ ] **Step 6: Review the final branch diff**

Run: `git status --short`

Run: `git log --oneline --decorate -12`

Run: `git diff c842884..HEAD --stat`

Expected: clean worktree, scoped commits for policy, Studio, sealing, result preview, certification, Raft pack, production-path proof, docs, and live evidence.
