# AgentBench Live

AgentBench Live is an evidence-first benchmark for coding and research agents, built for engineering leads and hiring teams who need to choose which agent configuration can be trusted with a real workflow. It gives agents the same task and budget, lets each agent choose the Solari primitives it needs, then independently rebuilds and verifies every submission in fresh infrastructure.

The result is a public scoreboard backed by observed builds, browser assertions, numerical reproductions, screenshots, and sanitized logs—not an agent claiming that it finished.

## What it demonstrates

AgentBench uses all three Solari primitives, selected per task rather than provisioned indiscriminately:

- **Sandbox** builds submitted applications and reruns computational experiments from scratch.
- **Browser** records the URL Shortener flow and verifies its final redirect target.
- **Desktop** captures permanent GUI evidence for the web task after the browser assertions pass.

The bundled tutorial compares two exact Codex configurations under identical prompts and budgets, while custom packs may use Codex, Anthropic, an OpenAI-compatible API, or any executable that implements the JSONL harness protocol:

| Agent | Model | Reasoning |
| --- | --- | --- |
| Sol · Low | `gpt-5.6-sol` | low |
| Luna · High | `gpt-5.6-luna` | high |

They solve two tasks: a complete URL Shortener application and a deterministic reproduction of the “Same Stats, Different Graph” simulated-annealing idea. Both bundled tutorial tasks are 100% deterministic and assign zero points to model-judge evaluators. The external `raft-consensus-reproduction` pack demonstrates the same system on a deeper distributed-systems paper reproduction.

## Architecture

```text
benchmark files ──> content-addressed snapshot ──> provider preflight
                                             │
Next.js dashboard ──> in-process queue ──> planning-only Codex call
        │                                      │
        │                               validated RunPlan
        │                                      │
        │                               generating Codex call
        │                                      │
        └── SQLite + SSE <── evaluator graph <── scanned submission
                                      │
                              verifier-owned evidence
                    static checks + model judge + optional Solari
```

Planning and generation are deliberately separate. Planning has no Solari tools attached, so no billable resource can exist before the plan passes the shared Zod/JSON Schema contract. The validated plan lets the agent choose browser, sandbox, and/or desktop only when the task permits them. Evaluation then runs a weighted prerequisite graph owned by the benchmark—not by the agent.

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
$env:AGENTBENCH_SNAPSHOT_PATH = ".agentbench/snapshots"
```

Then verify the local ChatGPT login without printing any token:

```powershell
codex login status
npm run dev
```

Open <http://localhost:3000>. With an empty database the dashboard displays a clearly labeled representative four-cell demo; persisted local runs take precedence as soon as one exists.

Open <http://localhost:3000/studio> to create a custom benchmark. Studio edits the canonical files directly, previews the exact YAML and prompt/rubric assets, detects external edits by revision hash, and atomically swaps a fully validated pack into `benchmarks/local`. Studio-authored packs use the same loader, content-addressed snapshot, orchestrator, and evaluator graph as external packs—there is no lighter test-only execution path. Save before dry-running or launching; paid launches require the explicit credit acknowledgement.

## Benchmark packs

Benchmark packs are canonical, version-controlled folders. The bundled tutorial is at `benchmarks/tutorials/agentbench-live`:

```text
agentbench-live/
  benchmark.yaml
  agents.yaml
  tasks/
    url-shortener/
      task.yaml
      prompt.md
    same-stats-different-graph/
      task.yaml
      prompt.md
      fixtures/seed.csv
```

`benchmark.yaml` declares pack identity and task roots, `agents.yaml` declares provider/model/harness identity, and each task owns its prompt, fixtures, resource policy, and evaluator declarations. Every run loads the complete pack into a content-addressed snapshot before provider preflight. Source edits after launch therefore affect only future runs. Snapshots default to `.agentbench/snapshots`; override that gitignored working location with `AGENTBENCH_SNAPSHOT_PATH`.

The built-in evaluator types are `file`, `schema`, `command`, `http`, `browser`, `numeric`, and `model-judge`. Enabled weights must total exactly 100. Model judges are capped at 30 points by default; exceeding the cap is invalid, and a majority additionally requires an explicit `allowModelJudgeMajority` opt-in. Prerequisites form an acyclic graph: a failed prerequisite skips its dependents but independent checks continue. Assertion failures earn zero or partial points; evaluator infrastructure errors invalidate the primary score instead of being misreported as a bad submission.

Command evaluators receive permission-hardened, tamper-evident sealed evaluator inputs at `/benchmark` and `/submission` and may write only their result area. A canonical path/size/SHA-256 manifest is checked after the entire dependent evaluator graph finishes; any mutation is an evaluator error and invalidates the score. Network is disabled with a fresh Linux network namespace unless the benchmark explicitly enables it. HTTP and recorded-browser evaluators target verifier-owned outputs such as a preceding command evaluator's preview URL. Model judges receive only declared artifacts and retain provider/model, sampling, rubric, prompt, input digests, usage, raw redacted responses, and repair count as provenance.

## Raft paper-reproduction pack

`examples/packs/raft-consensus-reproduction` is an external pack based on Ongaro and Ousterhout's [USENIX ATC 2014 paper page](https://www.usenix.org/conference/atc14/technical-sessions/presentation/ongaro) and [official PDF](https://www.usenix.org/system/files/conference/atc14/atc14-paper-ongaro.pdf). Its five deterministic fault scenarios reproduce and independently check:

- election safety: at most one leader exists in a term;
- log matching: equal index/term entries imply equal prefixes;
- leader completeness: committed entries appear in later leaders;
- state-machine safety: nodes never apply different commands at one index;
- quorum behavior: a minority cannot commit, while a connected majority can recover and commit.

The included reference submission is a dependency-free executable model of the paper's election, replication, partition, recovery, and divergent-log-repair subset—not a production Raft implementation. The verifier runs every scenario twice, derives claims from JSONL events instead of trusting the reported summary, and publishes a static trace viewer through an evaluator-owned Solari browser preview.

Validate the pack without provisioning anything, then create a public certificate with live Solari sandbox and browser evidence:

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

To discover additional packs, set `AGENTBENCH_BENCHMARK_ROOTS` to a platform-delimited list of pack roots. Use `;` on Windows and `:` on macOS/Linux:

```powershell
$env:AGENTBENCH_BENCHMARK_ROOTS = "benchmarks/tutorials/agentbench-live;D:\benchmarks\my-pack"
```

Relative entries resolve from the `agentbench-live` project directory. Surrounding whitespace and empty entries are ignored, duplicate resolved roots keep their first position, and an unset or empty value selects only the bundled tutorial. Invalid packs return a typed `benchmark_invalid` result without exposing configured absolute roots; unknown selections return `unknown_benchmark`, `unknown_task`, or `unknown_agent`.

## ChatGPT subscription vs API billing

AgentBench invokes the local Codex CLI and uses its existing ChatGPT sign-in. It does not need an OpenAI API key and does not place ChatGPT credentials inside a Solari VM, environment file, artifact, or public JSON document.

The ChatGPT subscription covers Codex according to the signed-in account’s current usage policy. Solari is separate: browser, sandbox, desktop, proxy, and captcha usage draw from the Solari account’s credit balance. Check the current rates and balance in the Solari console before starting a live matrix.

For API-backed agents, set `credential` in `agents.yaml` to a reference such as `anthropic-main`; never put a secret in a benchmark file. Map references to environment variable names with `AGENTBENCH_CREDENTIAL_ENV_MAP` or store them in the gitignored local credential file selected by `AGENTBENCH_CREDENTIAL_FILE`. Dashboard APIs expose only reference, label, source, and configured/missing state.

An `executable-jsonl` agent declares `options.command` as an argv array. Protocol version 1 exchanges one JSON object per line: the platform sends `initialize`, `plan`, `execute`, `tool_result`, and `cancel`; the harness replies with correlated `initialized`, `plan_result`, `event`, `tool_request`, `result`, or `error` messages. Lines are capped at 1 MiB, duplicate request IDs and malformed envelopes fail closed, and tool requests still pass through the benchmark's policy-bound broker.

## Commands

Validate an agent’s primitive plan and estimate the maximum resource time without provisioning Solari infrastructure:

```powershell
npm run agentbench -- dry-run --task url-shortener --agent sol-low
npm run agentbench -- dry-run --benchmark agentbench-live --task url-shortener --agent sol-low
```

Exercise one sandbox, one recorded browser, and one desktop sequentially; each resource is cleaned before the next begins:

```powershell
npm run agentbench -- smoke
```

Without `SOLARI_API_KEY`, this returns a typed `missing_credential` preflight report with `provisioned: false`; it does not create a browser, sandbox, or desktop.

Run one observed task:

```powershell
npm run agentbench -- run --task url-shortener --agent sol-low
npm run agentbench -- run --benchmark agentbench-live --task same-stats-different-graph --agent luna-high
```

Run the complete two-agent by two-task matrix. The command prints the maximum browser, sandbox, desktop, and total time before the required confirmation:

```powershell
npm run agentbench -- matrix --concurrency 1 --yes
npm run agentbench -- matrix --benchmark agentbench-live --concurrency 1 --yes
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

Every enabled evaluator contributes its declared share of 100 points. Results preserve `passed`, `failed`, `error`, and `skipped` as distinct states. Evidence is redacted before SHA-256 hashing, deduplicated in `.agentbench/evidence/sha256`, and indexed by immutable per-run manifests. SQLite also stores normalized evaluator results, assertions, and references so failed and invalid-score runs remain inspectable.

The URL Shortener tutorial performs static contract checks, starts the submitted application in a fresh network-enabled sandbox, and verifies its stable UI selectors in a recorded Solari browser. The research tutorial runs the exact seeded CLI twice without network access, checks byte reproducibility, recomputes sample means, sample variances, Pearson correlation, and ellipse RMSE, and scores each finding independently.

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
src/components/   Scoreboard, Studio, run detail, evidence, and live timeline
src/core/         Authoring, providers, evaluators, evidence, orchestration, Solari
src/server/       Server-only dependency composition
schemas/          Generated RunPlan JSON Schema
tests/            Unit, contract, integration, and UI tests
public/demo/      Redacted representative evidence
```

The implementation is local-first by design: SQLite and an in-process queue make a clean checkout runnable without Redis, Postgres, or a hosted worker fleet.
