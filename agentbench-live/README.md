# AgentBench Live

AgentBench Live is an evidence-first benchmark for coding and research agents. It gives agents the same task and budget, lets each agent choose the Solari primitives it needs, then independently rebuilds and verifies every submission in fresh infrastructure.

The result is a public scoreboard backed by observed builds, browser assertions, numerical reproductions, screenshots, and sanitized logs—not an agent claiming that it finished.

## What it demonstrates

AgentBench uses all three Solari primitives, selected per task rather than provisioned indiscriminately:

- **Sandbox** builds submitted applications and reruns computational experiments from scratch.
- **Browser** records the URL Shortener flow and verifies its final redirect target.
- **Desktop** captures permanent GUI evidence for the web task after the browser assertions pass.

The initial matrix compares two exact Codex configurations under identical prompts and budgets:

| Agent | Model | Reasoning |
| --- | --- | --- |
| Sol · Low | `gpt-5.6-sol` | low |
| Luna · High | `gpt-5.6-luna` | high |

They solve two tasks: a complete URL Shortener application and a deterministic reproduction of the “Same Stats, Different Graph” simulated-annealing idea.

## Architecture

```text
Next.js dashboard ──> in-process queue ──> planning-only Codex call
        │                                      │
        │                               validated RunPlan
        │                                      │
        │                               generating Codex call
        │                                      │
        └── SQLite + SSE <── verifier <── scanned submission
                                  │
                         fresh Solari resources
                    sandbox + browser + optional desktop
```

Planning and generation are deliberately separate. Planning has no Solari tools attached, so no billable resource can exist before the plan passes the shared Zod/JSON Schema contract. Generation runs locally with an ephemeral Codex process and a run-scoped Solari MCP configuration; verification uses task-owned code and fresh Solari resources.

## Requirements

- Node.js 20 or newer and npm
- The Codex CLI available on `PATH`
- A ChatGPT account signed into Codex
- A Solari account with an API key and sufficient credits for the resources you run

## Setup

```bash
git clone https://github.com/solari-sdk/solari-cookbook.git
cd solari-cookbook/agentbench-live
npm ci
cp .env.example .env.local
```

Set `SOLARI_API_KEY` in `.env.local` for the Next.js dashboard. For CLI commands, export it in the same shell:

```powershell
$env:SOLARI_API_KEY = "your-key-from-console.getsolari.com"
$env:AGENTBENCH_DATABASE_PATH = ".agentbench/agentbench.sqlite"
```

Then verify the local ChatGPT login without printing any token:

```powershell
codex login status
npm run dev
```

Open <http://localhost:3000>. With an empty database the dashboard displays a clearly labeled representative four-cell demo; persisted local runs take precedence as soon as one exists.

## ChatGPT subscription vs API billing

AgentBench invokes the local Codex CLI and uses its existing ChatGPT sign-in. It does not need an OpenAI API key and does not place ChatGPT credentials inside a Solari VM, environment file, artifact, or public JSON document.

The ChatGPT subscription covers Codex according to the signed-in account’s current usage policy. Solari is separate: browser, sandbox, desktop, proxy, and captcha usage draw from the Solari account’s credit balance. Check the current rates and balance in the Solari console before starting a live matrix.

## Commands

Validate an agent’s primitive plan and estimate the maximum resource time without provisioning Solari infrastructure:

```powershell
npm run agentbench -- dry-run --task url-shortener --agent sol-low
```

Exercise one sandbox, one recorded browser, and one desktop sequentially; each resource is cleaned before the next begins:

```powershell
npm run agentbench -- smoke
```

Run one observed task:

```powershell
npm run agentbench -- run --task url-shortener --agent sol-low
npm run agentbench -- run --task same-stats-different-graph --agent luna-high
```

Run the complete two-agent by two-task matrix. The command prints the maximum browser, sandbox, desktop, and total time before the required confirmation:

```powershell
npm run agentbench -- matrix --concurrency 1 --yes
```

Export the sanitized representative demo:

```powershell
npm run agentbench -- demo:seed
```

## Cost controls

- Default concurrency is one; the queue rejects values above the Starter-safe maximum of two.
- Every task has independent browser, sandbox, desktop, and total wall-clock budgets.
- Desktop is optional for agent exploration and is created by verification only when the evidence contract requires it.
- Planning runs before Solari MCP is attached.
- `dry-run` creates no Solari resources.
- The matrix requires explicit `--yes` confirmation after showing the maximum planned usage.
- A resource supervisor closes browsers and kills sandboxes/desktops in `finally`, then compares before/after inventories as a cleanup backstop.

## Evidence and scoring

Every task is normalized to 100 points:

- Core functional behavior or finding: 45
- Reproducible execution: 20
- Methodological fidelity: 15
- Evidence and provenance: 15
- Completion within budget: 5

The URL Shortener verifier performs a clean install and build, starts the application, submits a long URL through stable UI selectors, follows the generated short URL, checks the exact destination, retains a browser screenshot, and captures desktop evidence.

The research verifier executes the exact Python CLI twice, requires byte-identical point output, recomputes sample means, sample variances, Pearson correlation, and target-circle error, and validates the comparison PNG. Failed runs remain valid, clickable scoreboard entries with a typed failure code and last successful stage.

## Security model

- `.env.local`, run databases, workspaces, and raw artifacts are gitignored.
- Codex uses `--ephemeral`; its authentication cache is never packaged.
- `SOLARI_API_KEY` reaches subprocesses through the environment only.
- Submitted paths are canonicalized; symlinks, traversal, credential files, dependency caches, oversized files, and secret patterns are rejected.
- Logs redact Solari keys, bearer values, signed Solari URLs, and sensitive local paths before persistence and again at the SSE boundary.
- Public demo JSON deliberately omits replay URLs because Starter replay retention is temporary. Permanent PNGs remain reviewable after a replay expires.
- The MVP is a trusted local operator tool, not a multi-tenant hosted execution service.

## Tests

```powershell
npm run schema:generate
npm test
npm run typecheck
npm run lint
npm run build
```

The default suite uses fake Codex streams and mocked Solari adapters. Live checks are opt-in:

```powershell
$env:AGENTBENCH_LIVE = "1"
npm run agentbench -- smoke
```

Do not repeatedly retry a live command after an insufficient-credit response. Top up or wait for the next credit allocation, then rerun once.

## Demo evidence

Files under `public/demo/` are representative, deterministic seed artifacts generated by `demo:seed`; they are not presented as a completed paid Solari run. Once live verification succeeds, the same exporter can publish verifier-owned screenshots and redacted run DTOs without changing dashboard URLs or exposing temporary replay links.

## How AI was used

This project was designed and implemented with Codex as an active engineering collaborator. AI helped inspect the Solari SDKs, turn the handoff into an executable design and TDD plan, implement adapters and verifiers, generate fixtures, diagnose build and lifecycle failures, write tests and documentation, and visually QA the responsive dashboard. The benchmark itself applies the same philosophy: use AI aggressively, but trust independently reproduced evidence rather than prose claims.

## Project structure

```text
src/app/          Next.js dashboard, run API, and SSE routes
src/components/   Scoreboard, run detail, evidence, and live timeline
src/core/         Domain, agents, orchestration, Solari adapters, verifiers
src/server/       Server-only dependency composition
schemas/          Generated RunPlan JSON Schema
tests/            Unit, contract, integration, and UI tests
public/demo/      Redacted representative evidence
```

The implementation is local-first by design: SQLite and an in-process queue make a clean checkout runnable without Redis, Postgres, or a hosted worker fleet.
