# AgentBench Live — current implementation

Updated September 5, 2026 against the local working tree, not just its last
commit. This is the current product overview. Dated designs and plans preserve
earlier intent; they are not release certificates.

AgentBench runs configurable coding and research benchmarks with independent
evaluators and retained evidence. Solari supplies execution resources; model
providers are configured separately. The application is a trusted local operator
tool, not a hosted multi-tenant service.

## Implemented platform

- File-backed packs, validated snapshots, named agent presets, weighted evaluator
  prerequisite graphs, separate planning and execution, and policy-bound tools.
- Codex SDK/local sign-in, Anthropic, OpenAI-compatible, and executable JSONL
  adapters. The latest live batch exercised Codex, not every adapter.
- A dark dashboard, saved-pack reopening in Studio, task/agent selection,
  credential-reference metadata, SQLite records, SSE history, and polling/focus
  refreshes. The queue defaults to one concurrent run.
- File, schema, command, HTTP, browser, numeric, and model-judge evaluators.
- Redacted, content-addressed evidence with run-scoped artifact routes that
  verify ownership, SHA-256 digest, and byte length.

## Default task library

| Task | Pack / agent presets | Independent verification |
| --- | --- | --- |
| URL Shortener | `agentbench-live`: `sol-low`, `luna-high` | Contract checks, fresh sandbox build, recorded browser assertions and screenshots |
| Same Stats, Different Graph | `agentbench-live`: `sol-low`, `luna-high` | Offline seeded reproduction, byte reproducibility, statistics and ellipse RMSE |
| Raft Safety Under Faults | `raft-consensus-reproduction`: `raft-codex` | Repeated fault scenarios, trace-derived safety checks, recorded browser trace-viewer checks |

Both packs are v1.1.0. All three tasks use deterministic checks with zero
model-judge weight; agent generation is not deterministic. Empty/unset
`AGENTBENCH_BENCHMARK_ROOTS` discovers both packs; a nonempty override replaces
the defaults. Studio-saved writable packs also appear in the dashboard.
The separate Raft example was authored here, not contributed by an outside user.

URL Shortener allows browser, sandbox and desktop exploration; the research tasks
allow browser and sandbox. A RunPlan is intent, not execution evidence. Verifier
resources are benchmark-owned and separate from the agent's selections. No current
generic task has a desktop evaluator.

## Scoring and time

Current policy: **five-minute target, 15-minute hard cap**.

`timeAdjusted = round(quality × min(1, 300000 / elapsedMs), 2)`

Quality remains the evaluator score out of 100. Elapsed time includes planning,
generation, evaluation and cleanup, excluding queue time. A perfect ten-minute
run earns 100 quality and 50 time-adjusted. Invalid/incomplete runs have no
time-adjusted score. Custom packs opt in with `targetMinutes`; `totalMinutes`
is the hard limit. Historical runs are not rescored. Compare only the same task
snapshot and policy.

## Latest verified local batch

| Task / run ID | Duration | Quality | Time-adjusted | Outcome |
| --- | --- | --- | --- | --- |
| Statistics — `df0c80ab-bbae-44f3-b54b-624b5e09595c` | 147,598 ms | 100 | 100 | All ten evaluators passed; input seal and logs retained |
| URL Shortener — `206605e5-7870-4d32-888e-f6926834f595` | 342,158 ms | 73.33 | 64.29 | HTTP link on HTTPS deployment failed same-origin/redirect checks; six artifacts retained |
| Raft — `6d9ca115-4a6b-490f-8d0e-55da11b992f0` | 900,113 ms | — | — | Provider execution timed out before evaluation |

These are local observations, not public certificates, a completed two-model
matrix or proof of a universal winner. Statistics and URL use `sol-low`; Raft
uses `raft-codex`. The URL screenshots share a digest because the failed
same-origin check blocked navigation. See [the verification record](evidence-verification.md)
for historical attempts, snapshot changes and separate infrastructure diagnostics.

## Evidence: available versus unfinished

| Available now | Not established or not implemented |
| --- | --- |
| Local browser replay JSON and PNG screenshots; live-tested on URL Shortener | Embedded replay player, MP4 export, continuous full-agent video |
| Sandbox logs, assertions and input-integrity reports | Live terminal viewer or terminal video |
| Statistics reproduction results in evaluator reports | Retained statistics plot or browser recording for that task |
| Separate live desktop screenshot/readiness diagnostic | Scored desktop task or continuous desktop recording |
| Raft task, verifier and reference implementation | Successful current Raft agent run or new post-fix Raft certificate |

Replay uses Solari's CDP default context, release, bounded retrieval, local JSON
redaction and hashing. Missing evidence is labeled honestly. Lifecycle stages are
coarse orchestration labels, not measurements of each remote action.

Command inputs are permission-hardened and checked for mutation after the graph;
this is tamper detection, not an impenetrable multi-tenant filesystem boundary.
Offline evaluators fail closed if isolation is unavailable. A capability-dropped
network namespace was verified when nested user namespaces were unsupported.
URL Shortener and Raft explicitly allow evaluator networking.

## Verification and privacy

Latest implementation verification: 496 tests passed, four skipped; TypeScript,
ESLint and production build passed. URL/statistics artifact downloads returned
HTTP 200 with matching sizes and hashes. Final inventory checks returned zero
browsers, sandboxes and desktops at the end of that batch.

Keep credential stores, databases, snapshots, provider history and raw artifacts
private. Reports redact signed preview credentials, including legacy records on
read, but historical database bytes can retain released URLs. Never publish the
raw database. Screenshot pixels need visual review; text redaction is not OCR.

## Documentation map

- [Setup, architecture, commands and security](../README.md)
- [Review and filming walkthrough](../REVIEW-WALKTHROUGH.md)
- [Detailed verification](evidence-verification.md)
- [Raft certification status](../examples/packs/raft-consensus-reproduction/certification/STATUS.md)
- [Historical design and plan index](../../docs/README.md)

Update this overview and the setup README when behavior changes. Add dated
verification observations; do not silently rewrite old results.
