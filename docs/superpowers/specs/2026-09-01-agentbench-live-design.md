# AgentBench Live Design

## Summary

AgentBench Live is a public, evidence-first benchmark for coding and research
agents. It gives every agent the same task and resource budget, lets the agent
choose the Solari primitives it needs, and then independently verifies the
submission in fresh Solari infrastructure. The scoreboard reports observed
builds, assertions, numerical findings, recordings, screenshots, and logs
rather than trusting an agent's claim that it finished.

The first release is a hybrid benchmark with one web application task, one
computational-replication task, and one research-paper replication task. It is
implemented as a TypeScript application inside the public Solari cookbook fork.

## Goals

- Demonstrate a real use case for Solari browsers, sandboxes, and desktops.
- Compare agent configurations under identical prompts and resource limits.
- Let an agent select the Solari primitives appropriate to each task.
- Grade submissions using independent, task-owned verifiers.
- Publish reviewable evidence for every score.
- Run locally using an existing ChatGPT Codex subscription without committing
  or transmitting the user's Codex authentication material.
- Keep the MVP runnable with one command and without external queue or database
  services.

## Non-goals

- Supporting arbitrary untrusted public users in v1.
- Running a durable hosted multi-tenant service.
- Comparing every commercial coding-agent vendor in v1.
- GPU-heavy paper replication.
- Subjective visual-quality grading.
- Replacing Solari's own MCP server or SDKs.

## Architecture

The repository contains a Next.js dashboard and a local orchestrator. Codex
runs locally in disposable Git workspaces using the user's existing ChatGPT
authentication. Solari provides optional exploration tools to the agent and
fresh infrastructure for independent verification.

```text
Next.js dashboard
      |
      v
Local orchestrator ---> planner ---> Codex CLI adapter
      |                                  |
      |                           disposable workspace
      |                                  |
      +----> Solari MCP tools <-----------+
      |
      +----> independent Solari verifier
                    |
                    +--> sandbox execution and preview
                    +--> recorded browser assertions
                    +--> desktop evidence
                    |
                    v
             SQLite + local artifacts
```

The major boundaries are:

1. **Dashboard**: starts runs, streams stage updates, shows the scoreboard, and
   renders evidence.
2. **Task registry**: owns immutable prompts, resource policies, expected output
   contracts, hidden verifier logic, and scoring rules.
3. **Planner**: asks Codex for a schema-valid `RunPlan` before any billable
   resource is created.
4. **Agent adapter**: runs Codex non-interactively in an isolated local
   workspace and records structured JSONL events.
5. **Solari tool access**: exposes the official `@solarisdk/mcp` server to an
   execution run after its plan is approved.
6. **Verifier**: executes the submission from scratch in fresh Solari resources
   and produces task-owned assertions.
7. **Evidence store**: persists run metadata in SQLite and sanitized artifacts
   on disk.
8. **Queue**: caps local concurrency without Redis.

The queue and persistence layers use interfaces so BullMQ/Redis and Postgres can
replace their MVP implementations later without changing task or verifier code.

## Solari Primitive Selection

The selectable primitives are `browser`, `sandbox`, and `desktop`. In Solari's
terminology, the desktop product is the GUI VM primitive.

Before execution, the planner must emit:

```ts
type RunPlan = {
  primitives: Array<"browser" | "sandbox" | "desktop">
  reason: Partial<Record<"browser" | "sandbox" | "desktop", string>>
  verificationStrategy: string
}
```

Each task manifest declares allowed primitives and any evidence that its
verifier requires. The planner may choose any allowed combination. The
orchestrator rejects unknown, duplicate, forbidden, or unjustified primitives
before provisioning resources.

Typical plans are:

- Web application: sandbox plus browser; desktop when visual evidence helps.
- Command-line or data task: sandbox only.
- Browser automation: browser only.
- GUI workflow: desktop.
- Mixed research workflow: browser, sandbox, and optionally desktop.

Primitive choice affects the agent's tools, but not the verifier's authority.
A task verifier may independently require a clean sandbox or browser even when
the agent did not use one while solving the task.

## Run Lifecycle

Each job represents one agent configuration and one task.

```text
queued -> planning -> generating -> provisioning -> building
       -> verifying -> capturing -> completed
                              \----> failed
```

1. Load a versioned task manifest and create a run record.
2. Run a planning-only Codex invocation and validate its `RunPlan`.
3. Create a disposable local Git workspace.
4. Run Codex with the verbatim task prompt, approved plan, fixed model,
   reasoning effort, time limit, and run-scoped Solari MCP configuration.
5. Require the agent to place its final submission under `submission/`.
6. Scan and package the submission.
7. Create fresh verifier resources in Solari.
8. Install and execute the submission from scratch.
9. Run task-owned assertions and collect evidence.
10. Compute the score from observed verifier results.
11. Close browser sessions and kill created sandboxes or desktops in `finally`
    blocks.
12. Persist the final status even when execution or cleanup fails.

## Submission Contract

Every agent writes the following structure:

```text
submission/
  source/
  results.json
  methodology.md
  provenance.json
  artifacts/
```

Task manifests may make individual files optional when they do not apply, but
`results.json` is always required. The artifact packager rejects:

- Files outside `submission/`.
- Symlinks and path traversal.
- `.env` files and known credential files.
- Dependency directories and generated caches.
- Files above configured size limits.
- Content matching configured secret patterns.

The package contains source and declared evidence only. Codex transcripts and
authentication caches are never packaged.

## Agent Access and Independent Verification

Agent execution and grading are intentionally separate.

### Agent execution

Codex runs locally with `codex exec --ephemeral --json` and the user's existing
ChatGPT sign-in. The run receives the official Solari MCP server through a
temporary configuration. `SOLARI_API_KEY` is inherited by the MCP subprocess
from the orchestrator environment and is never written into repository files.

The agent may use Solari for source retrieval, exploratory computation, GUI
inspection, and prototyping. It must still save a complete submission locally.

### Independent verification

The verifier does not consume the agent's claimed pass/fail status. It:

1. Uploads the scanned submission to a clean Solari sandbox when required.
2. Installs dependencies from the submitted lockfile.
3. Executes the declared entry point.
4. Recomputes numerical results or runs browser/GUI assertions.
5. Captures task-required recordings and screenshots.
6. Compares observed output with task-owned expected values and tolerances.

This fresh execution is the evidence behind the scoreboard.

## Task Suite

### 1. URL Shortener

This control task validates the complete web build pipeline.

The agent builds an application that accepts a long URL, returns a short URL,
and redirects the short URL to the original destination. The verifier:

- Builds and starts the app in a Solari sandbox.
- Obtains a public preview URL.
- Opens a recorded Solari browser.
- Creates a short URL through the UI.
- Visits it and confirms the final destination.
- Captures browser assertions and a screenshot.

### 2. Same Stats, Different Graph

This computational-replication task is based on Autodesk Research's
"Same Stats, Different Graphs" work. The agent reimplements the core
simulated-annealing idea: transform a seed dataset toward a requested target
shape while preserving selected summary statistics.

The submission includes the implementation, generated points, a comparison
plot, and machine-readable statistics. The verifier independently checks:

- Means, standard deviations, and correlation against configured tolerances.
- Target-shape error using a task-owned geometric metric.
- Deterministic reproducibility from the supplied random seed.
- Successful execution within the CPU and time budget.

### 3. Minimum Wage and Employment

This flagship research task reproduces core results from Card and Krueger's
1994 New Jersey/Pennsylvania minimum-wage study.

The agent retrieves the paper and public data, documents provenance, recreates
the Table 3 employment comparisons, estimates the difference-in-differences
effect, and generates a counterfactual plot. The verifier uses a pinned source
URL and dataset checksum, explicit missing-data rules, and task-owned numerical
tolerances. The expected headline estimate is approximately `+2.75` full-time
equivalent jobs, with the exact expected value fixed by the pinned dataset and
rules.

The submission includes analysis code, a lockfile, `results.json`, the chart,
methodology notes, and source provenance.

## Scoring

Every task normalizes to 100 points:

- Core finding or functional behavior: 45 points.
- Successful reproducible execution: 20 points.
- Methodological fidelity: 15 points.
- Evidence and provenance: 15 points.
- Completion within the resource budget: 5 points.

Task verifiers define the observations that contribute to each category. A
failed prerequisite prevents dependent points. Duration is displayed but does
not otherwise influence ranking in v1.

The public repository makes the verifier contract transparent. Verifier code,
reference fixtures, checksums, numerical targets, and tolerance boundaries are
not copied into the disposable agent workspace, so an agent cannot modify its
grader during a run. The project does not claim that public verifier values are
secret; reproducibility and identical conditions are more important than test
obscurity in v1.

## Initial Agent Matrix

The first published matrix targets three Codex model configurations: Sol, Terra,
and Luna, all at the same medium reasoning effort where supported. The runner
resolves and records the exact model identifier before each run. If a configured
model is unavailable to the active ChatGPT subscription or installed Codex CLI,
the run fails with a typed configuration error; it never substitutes another
model silently.

All three configurations receive the same task prompt, task version, allowed
Solari primitives, verifier contract, wall-clock limit, and resource budget.
The adapter boundary permits future Claude Code, Aider, or other agents without
changing task or verifier implementations.

## Persistence and Evidence

SQLite stores one record per run. The core data model contains:

- `id`, `task_id`, and task version.
- Agent, model, and reasoning effort.
- Status and current stage.
- Validated run plan.
- Build, functional, methodology, evidence, and budget outcomes.
- Total score and duration.
- Failure stage and typed failure code.
- Sanitized logs.
- Recording and screenshot references.
- Created, started, and completed timestamps.

Local artifacts live under a gitignored run directory. Curated public demo
artifacts may be copied into `public/demo/`; that operation always runs the same
redaction and size checks as normal packaging. Solari replay URLs are references,
not permanent storage, so the public demo must retain canonical screenshots and
machine-readable verifier results even after replay retention expires.

## Dashboard

The dashboard contains:

1. **Scoreboard**: agent configurations as rows, tasks as columns, pass/fail
   state, per-task score, and total score.
2. **Run detail**: selected primitives and rationale, stage timeline, sanitized
   logs, verifier assertions, numerical comparison, methodology outcome, replay
   link, and screenshots.
3. **Live run**: streamed Codex/build events and current lifecycle stage.

Research-task details show expected versus observed metrics and side-by-side
charts. Failed runs remain clickable and show the last successful stage.

## Failure Handling

The orchestrator records typed outcomes:

- `plan_invalid`
- `agent_timeout`
- `agent_failed`
- `submission_invalid`
- `provision_failed`
- `build_failed`
- `verification_failed`
- `evidence_failed`
- `cleanup_failed`

A failure creates a valid run record. Cleanup failure is recorded separately so
it does not overwrite the benchmark result. Retry policy applies only to
transient infrastructure failures; deterministic agent, build, or assertion
failures are not retried automatically.

## Resource and Credential Safety

- The public repository contains `.env.example`, never `.env.local`.
- Codex authentication remains in the local credential store.
- Codex runs with `--ephemeral`.
- Solari keys are passed through process environment only.
- Logs redact Solari keys, bearer headers, signed session URLs, Codex tokens,
  and sensitive local paths.
- The supervisor records session IDs from structured tool events and compares
  Solari resource inventories before and after a run as a cleanup backstop.
- A watchdog enforces wall-clock and concurrency limits.
- Cleanup closes browsers and kills sandboxes/desktops created by the run.
- Default concurrency is one and the Starter maximum is two compute sessions.
- Every task specifies browser, sandbox, desktop, and total time budgets.
- Desktop is created only when the plan or evidence contract requires it.
- `--dry-run` validates plans and estimates resources without provisioning.
- Starting a full matrix requires an explicit CLI confirmation that summarizes
  the planned number of resources and estimated time.

## Testing Strategy

### Unit tests

- Task manifest and run-plan validation.
- State-machine transitions.
- Score calculation.
- Secret redaction.
- Artifact packaging and rejection rules.
- Resource-budget calculation.

### Verifier contract tests

- Known passing and failing submissions for each task.
- Numerical tolerance boundaries.
- Dataset checksum and missing-data handling.
- Browser assertion failures.
- Missing or malformed evidence.

### Integration tests

- Fake Codex JSONL streams.
- Mock Solari adapters.
- Queue concurrency and cancellation.
- Cleanup after every failure stage.
- Persistence and event streaming.

### Live smoke tests

- One sandbox command.
- One recorded browser navigation.
- One desktop screenshot.
- One complete URL-shortener run.

The research tasks run live only after the cheap smoke suite passes.

## Intentional Changes from the Initial Handoff

The following changes preserve the handoff's product concept while adapting it
to the available account and MVP scope:

- Codex runs locally so ChatGPT subscription authentication never enters a
  remote sandbox.
- SQLite replaces Postgres.
- An in-process queue replaces BullMQ and Redis.
- A structured primitive-selection step gives agents discretionary Solari use.
- The task suite becomes hybrid rather than three simple web applications.
- Desktop is optional per task, but the published benchmark includes desktop
  evidence so all three Solari primitives are demonstrated.

One job still represents one agent configuration and one task. Sandboxes build
and execute code, preview URLs feed browser verification, browser sessions are
recorded, desktops capture canonical evidence, and every failure remains a
scoreboard result.

## Definition of Done

The MVP is complete when:

- A clean checkout can install and start the dashboard and orchestrator.
- The runner detects an existing local Codex ChatGPT login and a Solari API key
  without persisting either credential.
- All three task types can execute through their complete lifecycle.
- Agents can select allowed Solari primitives through a validated plan.
- Every score derives from fresh, independent Solari verification.
- Unit, verifier, integration, and live smoke tests pass.
- The public scoreboard renders completed and failed runs with evidence.
- A seeded public demo includes at least one browser recording reference, one
  sandbox-verified result, and one desktop screenshot.
- The README explains setup, architecture, security, cost controls, and how AI
  was used to build the project.

## References

- Solari Cookbook: <https://github.com/solari-sdk/solari-cookbook>
- Solari MCP server: <https://docs.getsolari.com/mcp>
- Solari sandboxes: <https://docs.getsolari.com/sandboxes>
- Solari browsers: <https://docs.getsolari.com/browser-api>
- Solari desktops: <https://docs.getsolari.com/desktops>
- Same Stats, Different Graphs: <https://www.research.autodesk.com/publications/same-stats-different-graphs/>
- Card and Krueger paper: <https://esp.mit.edu/download/a1c6c55a9e61a353bced61b2b4725bca/S2790_Card_Krueger_1994.pdf>
- OpenAI Codex authentication: <https://developers.openai.com/codex/auth>
- OpenAI Codex pricing: <https://developers.openai.com/codex/pricing>
