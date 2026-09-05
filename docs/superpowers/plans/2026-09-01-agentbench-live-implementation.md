# AgentBench Live Implementation Plan

> Historical design/plan. For shipped behavior, current budgets, verified results
> and known limitations, see the [current implementation guide](../../../agentbench-live/docs/current-state.md).
> This document preserves earlier intent; it is not a release or live certificate.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a public, locally orchestrated benchmark that runs two Codex configurations on two tasks, lets each agent choose approved Solari primitives, and scores fresh Solari-verified evidence in a live Next.js dashboard.

**Architecture:** A Next.js application under `agentbench-live/` owns the dashboard and API. Focused core modules implement task contracts, Codex planning/generation, an in-process queue, SQLite persistence, artifact security, and Solari adapters; task-owned verifiers run submissions in fresh Solari resources and never trust agent-reported success. Codex authentication remains local, while `SOLARI_API_KEY` is inherited only by the official run-scoped Solari MCP subprocess and verifier SDK clients.

**Tech Stack:** Node.js 22+, TypeScript, Next.js App Router, React, Zod, Vitest, Testing Library, `better-sqlite3`, official Solari browser/sandbox/desktop TypeScript SDKs, Codex CLI, npm.

**Spec:** `docs/superpowers/specs/2026-09-01-agentbench-live-design.md`

## Global Constraints

- The application lives in `agentbench-live/`; existing cookbook examples remain unchanged.
- The public repository contains `.env.example` and never commits `.env.local`, Codex auth files, generated submissions, SQLite databases, or private run artifacts.
- Planning and generation are separate `codex exec` calls.
- Planning uses `--ephemeral`, `--json`, `--ignore-user-config`, `--output-schema`, no MCP configuration, one validation retry, and no billable Solari resource.
- Generation uses `--ephemeral`, `--json`, `--ignore-user-config`, the approved plan, and only the official `@solarisdk/mcp` server.
- The initial matrix is `gpt-5.6-sol` at low reasoning effort and `gpt-5.6-luna` at high reasoning effort; never silently substitute a model.
- One job is one agent configuration by one task.
- Default queue concurrency is one; maximum compute concurrency is two.
- Every billable resource is closed or killed in `finally` cleanup.
- Every run, including failures, is persisted with a typed stage and failure code.
- Verifier code and reference fixtures remain outside the disposable agent workspace.
- All implementation work follows red-green-refactor TDD and ends each task with a focused commit.

## File Map

```text
agentbench-live/
  .env.example                         environment variable names only
  package.json                         scripts and pinned dependencies
  src/app/                             Next.js pages and API routes
  src/components/                      scoreboard and evidence UI
  src/core/domain/                     shared schemas and run types
  src/core/tasks/                      immutable task manifests and prompts
  src/core/runner/                     state machine, queue, budgets, orchestration
  src/core/agents/                     Codex process, planner, generator, JSONL parsing
  src/core/security/                   workspace, packaging, and redaction
  src/core/persistence/                SQLite repository and migrations
  src/core/events/                     run event bus used by SSE
  src/core/solari/                      SDK adapters and resource supervisor
  src/core/verifiers/                  task-owned independent verifiers
  src/core/demo/                       safe seeded public results
  src/cli.ts                           dry-run, smoke, run, and matrix commands
  schemas/run-plan.schema.json         generated planner JSON Schema
  scripts/generate-run-plan-schema.ts  derives JSON Schema from Zod
  tests/                               unit, contract, integration, and UI tests
  tests/fixtures/                      passing/failing submissions and fake JSONL
  public/demo/                         curated non-secret screenshots/results
```

---

## Milestone 1: Core Runner

### Task 1: Scaffold the application and verification toolchain

**Files:**
- Create: `agentbench-live/package.json`
- Create: `agentbench-live/tsconfig.json`
- Create: `agentbench-live/next.config.ts`
- Create: `agentbench-live/vitest.config.ts`
- Create: `agentbench-live/src/app/layout.tsx`
- Create: `agentbench-live/src/app/page.tsx`
- Create: `agentbench-live/src/app/globals.css`
- Create: `agentbench-live/tests/setup.ts`
- Create: `agentbench-live/tests/app/smoke.test.tsx`
- Create: `agentbench-live/.env.example`
- Modify: `.gitignore`
- Modify: `README.md`

**Interfaces:**
- Produces npm scripts `dev`, `build`, `test`, `test:watch`, `typecheck`, `lint`, `schema:generate`, and `agentbench`.
- Produces import alias `@/* -> src/*` for every later task.

- [ ] **Step 1: Scaffold the Next.js application**

Run from the repository root:

```powershell
npx create-next-app@latest agentbench-live --ts --eslint --app --src-dir --use-npm --import-alias "@/*" --no-tailwind
cd agentbench-live
npm install zod zod-to-json-schema better-sqlite3 @solarisdk/browser @solarisdk/sandbox @solarisdk/desktop
npm install -D vitest jsdom @testing-library/react @testing-library/jest-dom @types/better-sqlite3 tsx
```

Keep the generated `package-lock.json`; remove the root `.gitignore` rule that currently ignores lockfiles.

- [ ] **Step 2: Write the failing dashboard smoke test**

```tsx
// tests/app/smoke.test.tsx
import { render, screen } from "@testing-library/react"
import Home from "@/app/page"

test("renders the AgentBench identity", () => {
  render(<Home />)
  expect(screen.getByRole("heading", { name: "AgentBench Live" })).toBeInTheDocument()
  expect(screen.getByText(/evidence-first benchmark/i)).toBeInTheDocument()
})
```

- [ ] **Step 3: Configure Vitest and verify the test fails**

```ts
// vitest.config.ts
import path from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: { environment: "jsdom", setupFiles: ["./tests/setup.ts"] },
})
```

```ts
// tests/setup.ts
import "@testing-library/jest-dom/vitest"
```

Run: `npm test -- tests/app/smoke.test.tsx`

Expected: FAIL because the generated page does not contain the required copy.

- [ ] **Step 4: Add the minimal branded page and scripts**

```tsx
// src/app/page.tsx
export default function Home() {
  return (
    <main>
      <p>Solari × Codex</p>
      <h1>AgentBench Live</h1>
      <p>An evidence-first benchmark for coding and research agents.</p>
    </main>
  )
}
```

Add these scripts to `package.json`:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "schema:generate": "tsx scripts/generate-run-plan-schema.ts",
    "agentbench": "tsx src/cli.ts"
  }
}
```

Set `.env.example` to:

```dotenv
SOLARI_API_KEY=
AGENTBENCH_DATABASE_PATH=.agentbench/agentbench.sqlite
AGENTBENCH_ARTIFACTS_DIR=.agentbench/runs
```

- [ ] **Step 5: Run the scaffold verification**

Run: `npm test -- tests/app/smoke.test.tsx && npm run typecheck && npm run lint`

Expected: all commands exit 0.

- [ ] **Step 6: Commit**

```powershell
git add .gitignore README.md agentbench-live
git commit -m "feat: scaffold AgentBench Live"
```

### Task 2: Define run plans, task manifests, and generated JSON Schema

**Files:**
- Create: `agentbench-live/src/core/domain/plan.ts`
- Create: `agentbench-live/src/core/domain/task.ts`
- Create: `agentbench-live/src/core/domain/run.ts`
- Create: `agentbench-live/src/core/tasks/registry.ts`
- Create: `agentbench-live/scripts/generate-run-plan-schema.ts`
- Create: `agentbench-live/schemas/run-plan.schema.json`
- Test: `agentbench-live/tests/core/domain.test.ts`
- Test: `agentbench-live/tests/core/schema-drift.test.ts`

**Interfaces:**
- Produces `Primitive`, `RunPlan`, `RunPlanSchema`, `TaskManifest`, `ResourceBudget`, `AgentConfig`, `RunRecord`, `RunStage`, and `FailureCode`.
- Produces `getTask(id: string): TaskManifest` and `listTasks(): TaskManifest[]`.

- [ ] **Step 1: Write failing schema and policy tests**

```ts
// tests/core/domain.test.ts
import { describe, expect, test } from "vitest"
import { RunPlanSchema, validatePlanForTask } from "@/core/domain/plan"
import type { TaskManifest } from "@/core/domain/task"

const task: TaskManifest = {
  id: "sample",
  version: "1.0.0",
  title: "Sample",
  prompt: "Build the sample.",
  allowedPrimitives: ["sandbox", "browser"],
  requiredEvidence: ["sandbox"],
  budget: { totalMs: 60_000, browserMs: 0, sandboxMs: 60_000, desktopMs: 0 },
  verifier: "sample",
}

test("rejects duplicate primitives", () => {
  expect(RunPlanSchema.safeParse({
    primitives: ["sandbox", "sandbox"],
    reason: { sandbox: "build" },
    verificationStrategy: "run tests",
  }).success).toBe(false)
})

test("fails closed when a plan requests a forbidden primitive", () => {
  expect(() => validatePlanForTask({
    primitives: ["desktop"],
    reason: { desktop: "inspect" },
    verificationStrategy: "screenshot",
  }, task)).toThrow(/desktop is not allowed/)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/core/domain.test.ts`

Expected: FAIL because the domain modules do not exist.

- [ ] **Step 3: Implement the exact schemas**

```ts
// src/core/domain/plan.ts
import { z } from "zod"
import type { TaskManifest } from "./task"

export const PrimitiveSchema = z.enum(["browser", "sandbox", "desktop"])
export type Primitive = z.infer<typeof PrimitiveSchema>

export const RunPlanSchema = z.object({
  primitives: z.array(PrimitiveSchema).min(1).superRefine((items, ctx) => {
    if (new Set(items).size !== items.length) {
      ctx.addIssue({ code: "custom", message: "primitives must be unique" })
    }
  }),
  reason: z.object({
    browser: z.string().min(3).optional(),
    sandbox: z.string().min(3).optional(),
    desktop: z.string().min(3).optional(),
  }),
  verificationStrategy: z.string().min(3),
}).superRefine((plan, ctx) => {
  for (const primitive of plan.primitives) {
    if (!plan.reason[primitive]) {
      ctx.addIssue({ code: "custom", message: `${primitive} requires a reason` })
    }
  }
})

export type RunPlan = z.infer<typeof RunPlanSchema>

export function validatePlanForTask(plan: RunPlan, task: TaskManifest): RunPlan {
  const forbidden = plan.primitives.find((item) => !task.allowedPrimitives.includes(item))
  if (forbidden) throw new Error(`${forbidden} is not allowed for task ${task.id}`)
  return plan
}
```

Define the remaining domain types with these exact unions:

```ts
export type RunStage = "queued" | "planning" | "generating" | "provisioning" | "building" | "verifying" | "capturing" | "completed" | "failed"
export type FailureCode = "plan_invalid" | "agent_timeout" | "agent_failed" | "submission_invalid" | "provision_failed" | "build_failed" | "verification_failed" | "evidence_failed" | "cleanup_failed"
export type ReasoningEffort = "low" | "high"
export type AgentConfig = { id: string; label: string; model: string; reasoningEffort: ReasoningEffort }
export type ResourceBudget = { totalMs: number; browserMs: number; sandboxMs: number; desktopMs: number }
```

- [ ] **Step 4: Generate the JSON Schema and lock it with a drift test**

```ts
// scripts/generate-run-plan-schema.ts
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { zodToJsonSchema } from "zod-to-json-schema"
import { RunPlanSchema } from "../src/core/domain/plan"

const output = `${JSON.stringify(zodToJsonSchema(RunPlanSchema, "RunPlan"), null, 2)}\n`
writeFileSync(resolve("schemas/run-plan.schema.json"), output)
```

```ts
// tests/core/schema-drift.test.ts
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "vitest"
import { zodToJsonSchema } from "zod-to-json-schema"
import { RunPlanSchema } from "@/core/domain/plan"

test("checked-in planner schema matches RunPlanSchema", () => {
  const checkedIn = JSON.parse(readFileSync(resolve("schemas/run-plan.schema.json"), "utf8"))
  expect(checkedIn).toEqual(zodToJsonSchema(RunPlanSchema, "RunPlan"))
})
```

Run: `npm run schema:generate && npm test -- tests/core/domain.test.ts tests/core/schema-drift.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add agentbench-live/src/core/domain agentbench-live/src/core/tasks agentbench-live/scripts agentbench-live/schemas agentbench-live/tests/core
git commit -m "feat: define AgentBench contracts"
```

### Task 3: Implement lifecycle, scoring, budgets, and the in-process queue

**Files:**
- Create: `agentbench-live/src/core/runner/state-machine.ts`
- Create: `agentbench-live/src/core/runner/scoring.ts`
- Create: `agentbench-live/src/core/runner/budget.ts`
- Create: `agentbench-live/src/core/runner/queue.ts`
- Test: `agentbench-live/tests/core/runner.test.ts`

**Interfaces:**
- Produces `transition(current: RunStage, next: RunStage): RunStage`.
- Produces `computeScore(outcome: ScoreOutcome): ScoreBreakdown`.
- Produces `estimateResources(items: MatrixItem[]): ResourceEstimate`.
- Produces `RunQueue.enqueue<T>(job: () => Promise<T>): Promise<T>` and `RunQueue.cancelPending(): number`.

- [ ] **Step 1: Write failing lifecycle and score tests**

```ts
// tests/core/runner.test.ts
import { expect, test } from "vitest"
import { transition } from "@/core/runner/state-machine"
import { computeScore } from "@/core/runner/scoring"

test("rejects lifecycle jumps", () => {
  expect(() => transition("queued", "verifying")).toThrow(/invalid transition/)
})

test("does not award dependent points after execution failure", () => {
  expect(computeScore({
    core: 45,
    reproducible: false,
    methodology: 15,
    evidence: 15,
    withinBudget: true,
  })).toEqual({ core: 0, reproducible: 0, methodology: 0, evidence: 0, budget: 0, total: 0 })
})
```

- [ ] **Step 2: Verify red**

Run: `npm test -- tests/core/runner.test.ts`

Expected: FAIL because the runner modules do not exist.

- [ ] **Step 3: Implement deterministic policy**

Use this transition map:

```ts
const allowed: Record<RunStage, RunStage[]> = {
  queued: ["planning", "failed"],
  planning: ["generating", "failed"],
  generating: ["provisioning", "failed"],
  provisioning: ["building", "failed"],
  building: ["verifying", "failed"],
  verifying: ["capturing", "completed", "failed"],
  capturing: ["completed", "failed"],
  completed: [],
  failed: [],
}
```

Implement scoring so the maximum categories are exactly `45/20/15/15/5`, and a failed reproducible execution zeros every category. Implement `RunQueue` with a constructor guard `1 <= concurrency <= 2`, FIFO pending jobs, and cancellation that rejects jobs not yet started with `QueueCancelledError`.

- [ ] **Step 4: Add the concurrency test and make it pass**

```ts
test("never executes more than two jobs", async () => {
  const queue = new RunQueue(2)
  let active = 0
  let peak = 0
  const job = () => queue.enqueue(async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 10))
    active -= 1
  })
  await Promise.all([job(), job(), job(), job()])
  expect(peak).toBe(2)
})
```

Run: `npm test -- tests/core/runner.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add agentbench-live/src/core/runner agentbench-live/tests/core/runner.test.ts
git commit -m "feat: add run lifecycle and queue"
```

### Task 4: Add SQLite persistence and run event streaming

**Files:**
- Create: `agentbench-live/src/core/persistence/repository.ts`
- Create: `agentbench-live/src/core/persistence/sqlite-repository.ts`
- Create: `agentbench-live/src/core/persistence/schema.sql`
- Create: `agentbench-live/src/core/events/run-events.ts`
- Test: `agentbench-live/tests/core/persistence.test.ts`
- Test: `agentbench-live/tests/core/events.test.ts`

**Interfaces:**
- Produces `RunRepository.create`, `RunRepository.get`, `RunRepository.list`, `RunRepository.update`, and `RunRepository.appendEvent`.
- Produces `RunEventBus.publish(runId, event)` and `RunEventBus.subscribe(runId, listener): () => void`.

- [ ] **Step 1: Write repository contract tests**

```ts
// tests/core/persistence.test.ts
import { afterEach, expect, test } from "vitest"
import { SqliteRunRepository } from "@/core/persistence/sqlite-repository"

let repository: SqliteRunRepository | undefined
afterEach(() => repository?.close())

test("persists failed runs and their last successful stage", () => {
  repository = new SqliteRunRepository(":memory:")
  const created = repository.create({ taskId: "url-shortener", agentId: "sol-low" })
  repository.update(created.id, { stage: "failed", failureCode: "build_failed", lastSuccessfulStage: "provisioning" })
  expect(repository.get(created.id)).toMatchObject({
    stage: "failed",
    failureCode: "build_failed",
    lastSuccessfulStage: "provisioning",
  })
})
```

- [ ] **Step 2: Verify red**

Run: `npm test -- tests/core/persistence.test.ts tests/core/events.test.ts`

Expected: FAIL because persistence and event modules do not exist.

- [ ] **Step 3: Implement schema and repository**

The `runs` table contains JSON text columns for `run_plan`, `score`, and `evidence`, plus scalar columns for every item in the spec data model. The `run_events` table contains `id`, `run_id`, `sequence`, `kind`, `payload`, and `created_at`; enforce `UNIQUE(run_id, sequence)`.

Use `better-sqlite3`, prepared statements, explicit JSON parse/stringify helpers, and `crypto.randomUUID()` for run IDs. Never interpolate values into SQL strings.

- [ ] **Step 4: Implement and test event ordering**

```ts
test("subscribers receive events in publish order", () => {
  const bus = new RunEventBus()
  const seen: number[] = []
  const unsubscribe = bus.subscribe("run-1", (event) => seen.push(event.sequence))
  bus.publish("run-1", { sequence: 1, kind: "stage", payload: {} })
  bus.publish("run-1", { sequence: 2, kind: "log", payload: {} })
  unsubscribe()
  expect(seen).toEqual([1, 2])
})
```

Run: `npm test -- tests/core/persistence.test.ts tests/core/events.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add agentbench-live/src/core/persistence agentbench-live/src/core/events agentbench-live/tests/core/persistence.test.ts agentbench-live/tests/core/events.test.ts
git commit -m "feat: persist runs and events"
```

### Task 5: Secure disposable workspaces, redaction, and submission packaging

**Files:**
- Create: `agentbench-live/src/core/security/redact.ts`
- Create: `agentbench-live/src/core/security/workspace.ts`
- Create: `agentbench-live/src/core/security/package-submission.ts`
- Test: `agentbench-live/tests/core/security.test.ts`

**Interfaces:**
- Produces `redact(value: string, context: RedactionContext): string`.
- Produces `createWorkspace(runId: string): Promise<DisposableWorkspace>` where `dispose()` removes only the validated run directory.
- Produces `packageSubmission(workspace, policy): Promise<SubmissionPackage>` with text entries and a SHA-256 digest.

- [ ] **Step 1: Write failing secret and path-safety tests**

```ts
// tests/core/security.test.ts
test("redacts keys, bearer headers, signed session URLs, and local roots", () => {
  const input = "Bearer slr_live_id_secret https://stream.getsolari.com/signed C:\\Users\\Admin\\repo"
  expect(redact(input, { localRoots: ["C:\\Users\\Admin\\repo"] })).not.toMatch(/secret|signed|Users\\Admin/)
})

test("rejects symlinks and dotenv files", async () => {
  const workspace = await fixtureWorkspace({
    "submission/results.json": "{}",
    "submission/.env": "SOLARI_API_KEY=leak",
  })
  await expect(packageSubmission(workspace, defaultPolicy)).rejects.toThrow(/\.env/)
})
```

- [ ] **Step 2: Verify red**

Run: `npm test -- tests/core/security.test.ts`

Expected: FAIL because security modules do not exist.

- [ ] **Step 3: Implement fail-closed packaging**

Use `lstat` to reject symlinks, `realpath` to require every entry under `<workspace>/submission`, and exact deny rules for `.env*`, `.codex`, `auth.json`, `node_modules`, `.venv`, `__pycache__`, `.next`, `dist`, and files over 2 MiB. Require `submission/results.json`; parse it as JSON before packaging. Hash sorted `relativePath + NUL + bytes` entries with SHA-256.

`createWorkspace` must use `mkdtemp(path.join(os.tmpdir(), "agentbench-"))`, create a Git repository, and validate the resolved directory starts with the generated `agentbench-` prefix before recursive removal.

- [ ] **Step 4: Run security tests and static checks**

Run: `npm test -- tests/core/security.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add agentbench-live/src/core/security agentbench-live/tests/core/security.test.ts
git commit -m "feat: secure agent submissions"
```

### Task 6: Implement the two-call Codex adapter

**Files:**
- Create: `agentbench-live/src/core/agents/process.ts`
- Create: `agentbench-live/src/core/agents/jsonl.ts`
- Create: `agentbench-live/src/core/agents/codex-planner.ts`
- Create: `agentbench-live/src/core/agents/codex-generator.ts`
- Create: `agentbench-live/src/core/agents/preflight.ts`
- Create: `agentbench-live/tests/fixtures/codex/planner-valid.jsonl`
- Create: `agentbench-live/tests/fixtures/codex/generator.jsonl`
- Test: `agentbench-live/tests/core/codex-adapter.test.ts`

**Interfaces:**
- Produces `CommandRunner.run(spec: CommandSpec): Promise<CommandResult>`.
- Produces `CodexPlanner.plan(input: PlannerInput): Promise<RunPlan>`.
- Produces `CodexGenerator.generate(input: GeneratorInput): Promise<GenerationResult>`.
- Produces `runPreflight(agent: AgentConfig): Promise<PreflightResult>`.

- [ ] **Step 1: Write argument-separation tests before process code**

```ts
// tests/core/codex-adapter.test.ts
test("planner registers no MCP server and retries invalid JSON once", async () => {
  const runner = new FakeCommandRunner([
    { exitCode: 0, outputFile: "{bad json" },
    { exitCode: 0, outputFile: JSON.stringify(validPlan) },
  ])
  const planner = new CodexPlanner(runner)
  await expect(planner.plan(input)).resolves.toEqual(validPlan)
  expect(runner.calls).toHaveLength(2)
  expect(runner.calls[0].args.join(" ")).not.toContain("mcp_servers")
  expect(runner.calls[0].args).toContain("--output-schema")
})

test("generator attaches only the Solari MCP server", async () => {
  const spec = buildGeneratorCommand(input)
  expect(spec.args).toContain("--ignore-user-config")
  expect(spec.args.join(" ")).toContain("mcp_servers.solari.command")
  expect(spec.args.join(" ")).toContain("@solarisdk/mcp")
  expect(spec.env?.SOLARI_API_KEY).toBe("test-solari-key")
})
```

- [ ] **Step 2: Verify red**

Run: `npm test -- tests/core/codex-adapter.test.ts`

Expected: FAIL because the adapter modules do not exist.

- [ ] **Step 3: Implement the process runner and JSONL parser**

Use `spawn` with `shell: false`, an explicit argv array, `windowsHide: true`, bounded stdout/stderr buffers, line-by-line JSONL callbacks, and an `AbortController` timeout. On timeout, terminate the child process tree and return an `agent_timeout` result. Redact every emitted line before publishing it.

The planning argv must include:

```ts
[
  "exec", "--ephemeral", "--json", "--skip-git-repo-check",
  "--ignore-user-config", "--model", agent.model,
  "-c", `model_reasoning_effort=\"${agent.reasoningEffort}\"`,
  "--output-schema", schemaPath,
  "-o", outputPath,
  plannerPrompt,
]
```

Parse `outputPath` with `JSON.parse`, then `RunPlanSchema.safeParse`, then `validatePlanForTask`. Retry exactly once with the formatted Zod error appended to the prompt. The second failure throws `PlanInvalidError` without invoking the generator.

The generation argv must include the approved plan in the prompt and these overrides:

```ts
[
  "exec", "--ephemeral", "--json", "--skip-git-repo-check",
  "--ignore-user-config", "--model", agent.model,
  "-c", `model_reasoning_effort=\"${agent.reasoningEffort}\"`,
  "-c", "mcp_servers.solari.command=\"npx\"",
  "-c", "mcp_servers.solari.args=[\"-y\",\"@solarisdk/mcp\"]",
  "--cd", workspace.root,
  taskPrompt,
]
```

The environment inherits the current process and requires `SOLARI_API_KEY`; do not serialize it into argv, logs, prompts, or files.

- [ ] **Step 4: Add preflight tests and implementation**

`runPreflight` executes `codex login status`, checks the exact configured model string is non-empty, and verifies `SOLARI_API_KEY` exists. Map login failure, missing key, and model rejection to `agent_failed` with detail codes `codex_not_logged_in`, `solari_key_missing`, or `model_unavailable`.

Run: `npm test -- tests/core/codex-adapter.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add agentbench-live/src/core/agents agentbench-live/tests/core/codex-adapter.test.ts agentbench-live/tests/fixtures/codex
git commit -m "feat: add two-stage Codex runner"
```

### Task 7: Compose the orchestrator with dry-run and failure persistence

**Files:**
- Create: `agentbench-live/src/core/runner/orchestrator.ts`
- Create: `agentbench-live/src/core/runner/contracts.ts`
- Test: `agentbench-live/tests/core/orchestrator.test.ts`

**Interfaces:**
- Consumes all Milestone 1 domain, repository, queue, security, and Codex interfaces.
- Produces `AgentBenchOrchestrator.run(request): Promise<RunRecord>` and `AgentBenchOrchestrator.dryRun(request): Promise<DryRunReport>`.
- Defers actual verification to `VerifierRegistry.verify(context)` implemented in Milestone 2.

- [ ] **Step 1: Write a failing dry-run and failure cleanup test**

```ts
test("dry-run validates a plan without invoking generation or verification", async () => {
  const harness = createHarness()
  const report = await harness.orchestrator.dryRun({ taskId: "url-shortener", agentId: "sol-low" })
  expect(report.plan.primitives).toContain("sandbox")
  expect(harness.generator.calls).toHaveLength(0)
  expect(harness.verifier.calls).toHaveLength(0)
})

test("persists generation failure and disposes the workspace", async () => {
  const harness = createHarness({ generatorError: new Error("boom") })
  const run = await harness.orchestrator.run(request)
  expect(run).toMatchObject({ stage: "failed", failureCode: "agent_failed" })
  expect(harness.workspace.disposed).toBe(true)
})
```

- [ ] **Step 2: Verify red**

Run: `npm test -- tests/core/orchestrator.test.ts`

Expected: FAIL because the orchestrator does not exist.

- [ ] **Step 3: Implement the pipeline**

Implement one private method per lifecycle stage. Each method transitions and persists before work begins, publishes an event after persistence, and returns typed data to the next stage. Wrap workspace and verifier resources in nested `try/finally`. Preserve the primary failure code; append `cleanup_failed` as a cleanup issue instead of overwriting the benchmark result.

`dryRun` stops after planning and returns the plan, task budget, required evidence, and estimated maximum Solari minutes.

- [ ] **Step 4: Run all Milestone 1 tests**

Run: `npm test -- tests/core && npm run typecheck && npm run lint`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add agentbench-live/src/core/runner/orchestrator.ts agentbench-live/src/core/runner/contracts.ts agentbench-live/tests/core/orchestrator.test.ts
git commit -m "feat: orchestrate benchmark runs"
```

---

## Milestone 2: Solari Verification and Tasks

### Task 8: Implement Solari adapters and resource supervision

**Files:**
- Create: `agentbench-live/src/core/solari/contracts.ts`
- Create: `agentbench-live/src/core/solari/clients.ts`
- Create: `agentbench-live/src/core/solari/resource-supervisor.ts`
- Create: `agentbench-live/src/core/solari/upload-tree.ts`
- Test: `agentbench-live/tests/core/solari-supervisor.test.ts`

**Interfaces:**
- Produces narrow `BrowserService`, `SandboxService`, and `DesktopService` interfaces.
- Produces `ResourceSupervisor.track(resource)` and `ResourceSupervisor.cleanup(): Promise<CleanupIssue[]>`.
- Produces `uploadTextTree(sandbox, package, destination): Promise<void>`.

- [ ] **Step 1: Write cleanup-order tests**

```ts
test("closes browsers before killing compute and records every cleanup error", async () => {
  const calls: string[] = []
  const supervisor = new ResourceSupervisor()
  supervisor.trackBrowser({ close: async () => { calls.push("browser"); throw new Error("close") } })
  supervisor.trackDesktop({ kill: async () => { calls.push("desktop") } })
  supervisor.trackSandbox({ kill: async () => { calls.push("sandbox") } })
  const issues = await supervisor.cleanup()
  expect(calls).toEqual(["browser", "desktop", "sandbox"])
  expect(issues).toHaveLength(1)
})
```

- [ ] **Step 2: Verify red**

Run: `npm test -- tests/core/solari-supervisor.test.ts`

Expected: FAIL because Solari modules do not exist.

- [ ] **Step 3: Implement narrow SDK adapters**

Wrap `@solarisdk/browser`, `@solarisdk/sandbox`, and `@solarisdk/desktop` behind project-owned interfaces. Keep SDK-specific method names inside `clients.ts`; verifiers consume only project interfaces. Use a single `SOLARI_API_KEY` constructor input and the default `https://api.getsolari.com` base URL.

`uploadTextTree` writes sorted package entries below `/work/submission`, creates parents first, and rejects destinations outside `/work/submission`. It never uploads local paths or environment files.

- [ ] **Step 4: Add inventory-diff behavior**

Before generation, record browser/sandbox/desktop inventories. After generation, parse structured MCP tool events for session IDs and compare inventories. Track only new IDs; never kill pre-existing user resources. Contract-test inventory diff with fake adapters.

Run: `npm test -- tests/core/solari-supervisor.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add agentbench-live/src/core/solari agentbench-live/tests/core/solari-supervisor.test.ts
git commit -m "feat: supervise Solari resources"
```

### Task 9: Add the URL Shortener task and three-primitive verifier

**Files:**
- Create: `agentbench-live/src/core/tasks/url-shortener.ts`
- Create: `agentbench-live/src/core/verifiers/url-shortener.ts`
- Create: `agentbench-live/tests/fixtures/url-shortener/passing/submission/source/package.json`
- Create: `agentbench-live/tests/fixtures/url-shortener/passing/submission/source/server.mjs`
- Create: `agentbench-live/tests/fixtures/url-shortener/passing/submission/results.json`
- Create: `agentbench-live/tests/fixtures/url-shortener/failing/submission/results.json`
- Test: `agentbench-live/tests/verifiers/url-shortener.test.ts`

**Interfaces:**
- Registers task ID `url-shortener`, version `1.0.0`.
- Produces `UrlShortenerVerifier.verify(context): Promise<VerificationResult>`.
- Requires stable UI selectors `#long-url`, `#shorten`, and `#short-url` in the task prompt.

- [ ] **Step 1: Write the failing verifier contract test**

```ts
test("scores an independently observed redirect and captures all three primitives", async () => {
  const services = createPassingUrlShortenerServices()
  const result = await new UrlShortenerVerifier(services).verify(fixturePackage("passing"))
  expect(result.functional.passed).toBe(true)
  expect(result.evidence).toMatchObject({ browserRecording: expect.any(String), desktopScreenshot: expect.any(String) })
  expect(services.sandbox.killed).toBe(true)
  expect(services.browser.closed).toBe(true)
  expect(services.desktop.killed).toBe(true)
})
```

- [ ] **Step 2: Verify red**

Run: `npm test -- tests/verifiers/url-shortener.test.ts`

Expected: FAIL because the task and verifier do not exist.

- [ ] **Step 3: Implement the manifest and prompt**

Allow all three primitives; require sandbox and browser evidence. The prompt requires a dependency lockfile, `npm run build`, `npm start -- --hostname 0.0.0.0 --port 3000`, persistent redirects for the process lifetime, the three stable selectors, and the submission contract. Do not expose verifier input URLs in the prompt.

- [ ] **Step 4: Implement independent verification**

The verifier must:

1. Create and connect a clean sandbox with a five-minute idle timeout.
2. Upload the submission source.
3. Run `npm ci`, then `npm run build`; map non-zero exits to `build_failed`.
4. Start the app in the background and obtain `previewUrl(3000)`.
5. Launch a Solari browser with `recording: true`.
6. Submit `https://example.com/agentbench/verification?nonce=<runId>` through the UI.
7. Visit the returned short URL and assert the final URL exactly matches the original.
8. Release the browser, poll the replay URL for up to 30 seconds, and save the browser screenshot.
9. Create a Solari desktop, open the preview in Chrome, wait for health, and save the canonical PNG.
10. Cleanup browser, desktop, and sandbox in `finally`.

The verifier derives the score categories from these observations and never reads the agent's claimed pass/fail flag.

- [ ] **Step 5: Run the contract tests**

Run: `npm test -- tests/verifiers/url-shortener.test.ts`

Expected: passing fixture receives functional and evidence points; failing fixture does not.

- [ ] **Step 6: Commit**

```powershell
git add agentbench-live/src/core/tasks/url-shortener.ts agentbench-live/src/core/verifiers/url-shortener.ts agentbench-live/tests/verifiers agentbench-live/tests/fixtures/url-shortener
git commit -m "feat: verify URL shortener submissions"
```

### Task 10: Add the Same Stats task and numerical verifier

**Files:**
- Create: `agentbench-live/src/core/tasks/same-stats.ts`
- Create: `agentbench-live/src/core/verifiers/same-stats.ts`
- Create: `agentbench-live/src/core/verifiers/geometry.ts`
- Create: `agentbench-live/tests/fixtures/same-stats/seed.csv`
- Create: `agentbench-live/tests/fixtures/same-stats/passing/submission/source/reproduce.py`
- Create: `agentbench-live/tests/fixtures/same-stats/passing/submission/source/requirements.txt`
- Create: `agentbench-live/tests/fixtures/same-stats/passing/submission/results.json`
- Test: `agentbench-live/tests/verifiers/same-stats.test.ts`

**Interfaces:**
- Registers task ID `same-stats-different-graph`, version `1.0.0`.
- Produces `SameStatsVerifier.verify(context): Promise<VerificationResult>`.
- Produces pure `summaryStats(points)` and `circleError(points, target)` helpers.

- [ ] **Step 1: Write numerical boundary tests**

```ts
test("accepts summary statistics inside tolerance and rejects the boundary outside it", () => {
  const expected = { meanX: 54.27, meanY: 47.84, varianceX: 280.90, varianceY: 725.23, correlation: -0.07 }
  expect(withinStatsTolerance({ ...expected, meanX: 54.31 }, expected, 0.05)).toBe(true)
  expect(withinStatsTolerance({ ...expected, meanX: 54.33 }, expected, 0.05)).toBe(false)
})

test("circle error is lower for points near the target circumference", () => {
  expect(circleError(circlePoints, targetCircle)).toBeLessThan(circleError(linePoints, targetCircle))
})
```

- [ ] **Step 2: Verify red**

Run: `npm test -- tests/verifiers/same-stats.test.ts`

Expected: FAIL because the numerical helpers do not exist.

- [ ] **Step 3: Implement the task contract and pure math**

The prompt requires `source/reproduce.py` with CLI:

```text
python3 reproduce.py --input <seed.csv> --output <directory> --target circle --seed 1729
```

It must create `<directory>/results.json`, `<directory>/points.csv`, and `<directory>/comparison.png`. Require deterministic output for seed `1729` and a documented simulated-annealing acceptance rule.

Use sample means, sample variances (`n - 1`), and Pearson correlation. The target circle is centered at `(54.27, 47.84)` with x radius `16.76` and y radius `26.93`; `circleError` is the root-mean-square absolute deviation of normalized radial distance from `1.0`.

- [ ] **Step 4: Implement sandbox verification**

The verifier uploads the source and a task-owned seed CSV, installs `requirements.txt`, executes the exact CLI twice in separate output directories, and requires byte-identical `points.csv` files. It independently parses the points, recomputes statistics, checks each normalized statistic within `0.05` of the reference, requires circle error below the fixture-tested threshold, and confirms a non-empty PNG. Methodology points require a readable `methodology.md` containing the seed, objective function, temperature schedule, and acceptance rule headings.

- [ ] **Step 5: Run contract tests**

Run: `npm test -- tests/verifiers/same-stats.test.ts`

Expected: PASS for the valid fixture and deterministic failures at the tolerance, shape, and reproducibility boundaries.

- [ ] **Step 6: Commit**

```powershell
git add agentbench-live/src/core/tasks/same-stats.ts agentbench-live/src/core/verifiers agentbench-live/tests/verifiers/same-stats.test.ts agentbench-live/tests/fixtures/same-stats
git commit -m "feat: verify computational replications"
```

### Task 11: Register verifiers, finish orchestration, and add live smoke commands

**Files:**
- Create: `agentbench-live/src/core/verifiers/registry.ts`
- Create: `agentbench-live/src/core/solari/smoke.ts`
- Create: `agentbench-live/src/cli.ts`
- Modify: `agentbench-live/src/core/tasks/registry.ts`
- Modify: `agentbench-live/src/core/runner/orchestrator.ts`
- Test: `agentbench-live/tests/integration/pipeline.test.ts`
- Test: `agentbench-live/tests/integration/cli.test.ts`

**Interfaces:**
- Produces CLI commands `dry-run`, `smoke`, `run`, and `matrix`.
- Produces `VerifierRegistry.get(taskId)` and connects it to the orchestrator.

- [ ] **Step 1: Write failing integration tests with fake Codex and Solari adapters**

```ts
test("runs the complete two-agent by two-task matrix with concurrency one", async () => {
  const harness = createIntegrationHarness()
  const records = await harness.runMatrix({ confirm: true, concurrency: 1 })
  expect(records).toHaveLength(4)
  expect(records.map((run) => [run.agentId, run.taskId])).toEqual(expect.arrayContaining([
    ["sol-low", "url-shortener"],
    ["sol-low", "same-stats-different-graph"],
    ["luna-high", "url-shortener"],
    ["luna-high", "same-stats-different-graph"],
  ]))
})

test("matrix refuses to start without explicit confirmation", async () => {
  await expect(runCli(["matrix", "--yes=false"])).rejects.toThrow(/confirmation required/)
})
```

- [ ] **Step 2: Verify red**

Run: `npm test -- tests/integration/pipeline.test.ts tests/integration/cli.test.ts`

Expected: FAIL because registry and CLI do not exist.

- [ ] **Step 3: Implement registry, CLI, and smoke suite**

Use exact agent configs:

```ts
export const agents = [
  { id: "sol-low", label: "Sol · Low", model: "gpt-5.6-sol", reasoningEffort: "low" },
  { id: "luna-high", label: "Luna · High", model: "gpt-5.6-luna", reasoningEffort: "high" },
] as const
```

`matrix` prints the two tasks, two agents, concurrency, maximum browser/sandbox/desktop minutes, and requires `--yes`. `smoke` runs one sandbox command, one recorded browser navigation, and one desktop screenshot sequentially, cleaning each resource before continuing. Live tests are opt-in behind `AGENTBENCH_LIVE=1` and never run in the default `npm test` command.

- [ ] **Step 4: Run the complete non-live backend suite**

Run: `npm test -- tests/core tests/verifiers tests/integration && npm run typecheck && npm run lint`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add agentbench-live/src/core/verifiers/registry.ts agentbench-live/src/core/solari/smoke.ts agentbench-live/src/core/tasks/registry.ts agentbench-live/src/core/runner/orchestrator.ts agentbench-live/src/cli.ts agentbench-live/tests/integration
git commit -m "feat: complete benchmark pipeline"
```

---

## Milestone 3: Dashboard and Public Release

### Task 12: Add run APIs and server-sent events

**Files:**
- Create: `agentbench-live/src/server/container.ts`
- Create: `agentbench-live/src/app/api/runs/route.ts`
- Create: `agentbench-live/src/app/api/runs/[id]/route.ts`
- Create: `agentbench-live/src/app/api/runs/[id]/events/route.ts`
- Test: `agentbench-live/tests/app/run-api.test.ts`

**Interfaces:**
- `POST /api/runs` accepts `{ taskId, agentId, dryRun?: boolean }`.
- `GET /api/runs` lists runs; `GET /api/runs/:id` returns one run.
- `GET /api/runs/:id/events` streams persisted history followed by live SSE events.

- [ ] **Step 1: Write failing route tests**

```ts
test("rejects an unknown task before enqueueing", async () => {
  const response = await POST(request({ taskId: "unknown", agentId: "sol-low" }))
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: "unknown_task" })
})

test("returns a queued run for a valid request", async () => {
  const response = await POST(request({ taskId: "url-shortener", agentId: "sol-low" }))
  expect(response.status).toBe(202)
  expect(await response.json()).toMatchObject({ stage: "queued" })
})
```

- [ ] **Step 2: Verify red**

Run: `npm test -- tests/app/run-api.test.ts`

Expected: FAIL because routes do not exist.

- [ ] **Step 3: Implement server-only dependency composition and routes**

Create one lazy singleton container for repository, event bus, queue, adapters, and orchestrator. Mark it `server-only`; no API key or SDK client may enter a client component. Validate request bodies with Zod. The SSE route sends `id`, `event`, and JSON `data` fields, includes a 15-second heartbeat, unsubscribes on request abort, and never streams unredacted logs.

- [ ] **Step 4: Run route tests**

Run: `npm test -- tests/app/run-api.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add agentbench-live/src/server agentbench-live/src/app/api agentbench-live/tests/app/run-api.test.ts
git commit -m "feat: expose benchmark run APIs"
```

### Task 13: Build the scoreboard, run detail, and live timeline

**Files:**
- Modify: `agentbench-live/src/app/page.tsx`
- Create: `agentbench-live/src/app/runs/[id]/page.tsx`
- Create: `agentbench-live/src/components/scoreboard.tsx`
- Create: `agentbench-live/src/components/run-card.tsx`
- Create: `agentbench-live/src/components/stage-timeline.tsx`
- Create: `agentbench-live/src/components/evidence-panel.tsx`
- Create: `agentbench-live/src/components/live-run.tsx`
- Modify: `agentbench-live/src/app/globals.css`
- Test: `agentbench-live/tests/app/scoreboard.test.tsx`
- Test: `agentbench-live/tests/app/run-detail.test.tsx`

**Interfaces:**
- Consumes only serialized run DTOs from the API/repository.
- Produces accessible links to `/runs/:id` and a client-side SSE live timeline.

- [ ] **Step 1: Write failing dashboard behavior tests**

```tsx
test("renders agents as rows and tasks as columns", () => {
  render(<Scoreboard agents={agents} tasks={tasks} runs={seedRuns} />)
  expect(screen.getByRole("row", { name: /Sol · Low/ })).toBeInTheDocument()
  expect(screen.getByRole("columnheader", { name: /URL Shortener/ })).toBeInTheDocument()
  expect(screen.getByRole("columnheader", { name: /Same Stats/ })).toBeInTheDocument()
})

test("failed runs expose their last successful stage", () => {
  render(<RunCard run={failedRun} />)
  expect(screen.getByText(/failed during building/i)).toBeInTheDocument()
  expect(screen.getByText(/last completed: provisioning/i)).toBeInTheDocument()
})
```

- [ ] **Step 2: Verify red**

Run: `npm test -- tests/app/scoreboard.test.tsx tests/app/run-detail.test.tsx`

Expected: FAIL because dashboard components do not exist.

- [ ] **Step 3: Implement the evidence-first UI**

Use semantic tables for the matrix, visible pass/fail/score text in addition to color, and a restrained dark visual system. The run detail page must render primitive rationale, stage timeline, category scores, expected-versus-observed numerical metrics, sanitized logs, replay link, browser screenshot, and desktop screenshot. Missing or expired replay links render an explicit retention message while canonical screenshots remain visible.

`LiveRun` connects with `EventSource`, appends ordered events, reconnects using the last event ID, and closes the connection when the run reaches `completed` or `failed`.

- [ ] **Step 4: Run UI and production-build verification**

Run: `npm test -- tests/app && npm run typecheck && npm run build`

Expected: PASS and a successful Next.js production build.

- [ ] **Step 5: Commit**

```powershell
git add agentbench-live/src/app agentbench-live/src/components agentbench-live/tests/app
git commit -m "feat: add evidence scoreboard"
```

### Task 14: Seed a safe demo, document the project, and verify the release

**Files:**
- Create: `agentbench-live/src/core/demo/seed.ts`
- Create: `agentbench-live/public/demo/url-shortener-desktop.png`
- Create: `agentbench-live/public/demo/same-stats-comparison.png`
- Create: `agentbench-live/public/demo/runs.json`
- Create: `agentbench-live/README.md`
- Modify: `README.md`
- Test: `agentbench-live/tests/core/demo.test.ts`

**Interfaces:**
- Produces `npm run agentbench -- demo:seed` and a public demo that contains no credentials or signed session URLs.

- [ ] **Step 1: Write the failing demo safety test**

```ts
test("public demo contains no credential material", async () => {
  const files = await readPublicDemoFiles()
  for (const [name, content] of files) {
    expect(content, name).not.toMatch(/slr_live_|Authorization:\s*Bearer|auth\.json|stream\.getsolari\.com\/[^\s]+/)
  }
})
```

- [ ] **Step 2: Verify red**

Run: `npm test -- tests/core/demo.test.ts`

Expected: FAIL before the safe demo exporter exists.

- [ ] **Step 3: Implement demo export and documentation**

`demo:seed` copies only verifier-owned PNGs and redacted run DTOs through the existing packager/redactor. It removes replay URLs from committed JSON because Starter replay retention is seven days. The project README must lead with the two-sentence pitch, then cover architecture, all three Solari primitives, task suite, exact setup, ChatGPT-vs-API authentication, environment variables, dry-run, smoke, single run, matrix confirmation, costs, security, tests, evidence retention, and explicit AI assistance. Update the cookbook root README with one `AgentBench Live` section linking to the app.

- [ ] **Step 4: Run the full local release gate**

Run:

```powershell
npm run schema:generate
npm test
npm run typecheck
npm run lint
npm run build
git diff --exit-code -- schemas/run-plan.schema.json
```

Expected: every command exits 0 and schema generation produces no diff.

- [ ] **Step 5: Run live verification when credentials and Solari balance are ready**

Run:

```powershell
$env:AGENTBENCH_LIVE = "1"
npm run agentbench -- smoke
npm run agentbench -- run --task url-shortener --agent sol-low --yes
npm run agentbench -- matrix --concurrency 1 --yes
```

Expected: smoke creates and cleans one sandbox, browser, and desktop; the single control run completes with recording and desktop evidence; the four-cell matrix persists final results. If the console balance is still zero, stop after the explicit `InsufficientCredit` result and do not retry repeatedly.

- [ ] **Step 6: Export the verified demo and rerun safety checks**

Run: `npm run agentbench -- demo:seed && npm test -- tests/core/demo.test.ts`

Expected: PASS and public artifacts contain no secret material.

- [ ] **Step 7: Commit**

```powershell
git add README.md agentbench-live/README.md agentbench-live/src/core/demo agentbench-live/public/demo agentbench-live/tests/core/demo.test.ts
git commit -m "docs: prepare AgentBench public demo"
```

## Final Verification Checklist

- [ ] `git status --short` is clean.
- [ ] `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` pass.
- [ ] Checked-in `schemas/run-plan.schema.json` matches the Zod source.
- [ ] `codex login status` confirms ChatGPT authentication without exposing tokens.
- [ ] Dry-run creates no Solari resources.
- [ ] Live smoke leaves no browser, sandbox, or desktop running.
- [ ] The URL Shortener verifier records a browser flow and captures a desktop screenshot.
- [ ] The Same Stats verifier proves deterministic output, statistic preservation, and target-shape fit.
- [ ] The scoreboard shows four cells: two agents by two tasks.
- [ ] Failed fixtures remain visible and scored as failures.
- [ ] Public demo files pass credential scanning.
- [ ] README contains the application instructions and submission narrative.
