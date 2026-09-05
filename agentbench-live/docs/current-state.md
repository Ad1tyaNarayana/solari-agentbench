# AgentBench Live — current implementation

Updated September 5, 2026 for the reviewed implementation release. This overview summarizes
the implemented platform and observed local results.

AgentBench runs configurable coding and research benchmarks with independent
evaluators and retained evidence. Solari supplies execution resources; model
providers are configured separately. The application is a trusted local operator tool.

**Demonstrated:** a same-snapshot Sol/Luna comparison, successful independent
statistics reproduction for both configurations, and browser checks that caught
URL Shortener deployment failures after agent-reported success. Captured artifacts
passed download, size and hash checks. **Raft has not passed:** its latest results
schema failure prevented reproduction and browser verification.

**[Inspect the public evidence excerpt](review-evidence/README.md):** original
browser screenshots, selected assertions, scores, integrity reports and a short
walkthrough. No credentials, installation or paid run required.

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

| Task | Demonstration status | Configured independent verification |
| --- | --- | --- |
| URL Shortener | **Evaluated — partial pass** | Contract checks, fresh sandbox build, recorded browser assertions and screenshots |
| Same Stats, Different Graph | **Evaluated — full pass** | Offline seeded reproduction, byte reproducibility, statistics and ellipse RMSE |
| Raft Safety Under Faults | **Unverified replication — results contract failed** | Repeated fault scenarios, trace-derived safety checks, recorded browser trace-viewer checks |

The tutorial pack (`agentbench-live`) offers `sol-low` and `luna-high` for its
two tasks. The Raft pack (`raft-consensus-reproduction`) offers `raft-codex`.
Configured checks describe what would run, not proof that a task has completed.

Both packs are v1.1.0. All three tasks use deterministic checks with zero
model-judge weight; agent generation is not deterministic. Empty/unset
`AGENTBENCH_BENCHMARK_ROOTS` discovers both packs; a nonempty override replaces
the defaults. Studio-saved writable packs also appear in the dashboard.
Both shipped packs were authored in this repository.

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

**Policy visibility:** the Codex execution prompt explicitly tells the agent
the target, hard cap and formula. This is deliberate and unchanged for the
comparison runs. The metric penalizes lateness;
it gives no extra multiplier below five minutes. Waiting does not improve the
score, and lower quality still reduces it. Agents may choose quality/time
tradeoffs, so report quality and raw duration alongside the adjusted score.

## Observed configuration comparison

Both configurations ran both tutorial tasks on the **same snapshot and timing
policy**. Sol is `gpt-5.6-sol` with low reasoning; Luna is `gpt-5.6-luna` with high
reasoning. These are configuration comparisons, not a controlled test of model
identity alone.

| Task | Configuration | Duration | Quality | Time-adjusted |
| --- | --- | --- | --- | --- |
| URL Shortener | Sol · Low | 342,158 ms | 73.33 | 64.29 |
| URL Shortener | Luna · High | 415,976 ms | 73.33 | 52.89 |
| Statistics | Sol · Low | 147,598 ms | 100 | 100 |
| Statistics | Luna · High | 337,278 ms | 100 | 88.95 |

Both configurations passed every statistics evaluator. Both URL submissions
failed the same-origin and final-URL browser checks, retaining six artifacts each.
Each URL run's two screenshots share a digest because navigation was blocked.
Sol was faster with equal measured quality **in these samples**. This is one
sequential observation per configuration/task, not repeated randomized trials;
provider and infrastructure latency can affect timing. It does not establish a
universal winner. Earlier failures remain in the history.

Tutorial snapshot: `eeaef41fa77d73509cbb84a12fb4c426e0e9187368bfd063dd723cd436c3dbee`.
Run IDs, artifact checks and earlier attempts are in the
[verification record](evidence-verification.md). A reviewed subset is published
in the [evidence excerpt](review-evidence/results.json); the raw database stays
private. This is an author-published record, not third-party certification.

**Raft replication remains unverified.** The single follow-up attempt
`7e5cda2b-544d-4fb6-8765-40e67c466f30` finished in 592,394 ms with **10 quality /
5.06 time-adjusted** from static checks only. Its `results.json` failed the schema
contract, so reproduction and browser verification were skipped and no capture
artifacts were produced. “Completed” means the evaluation pipeline ended, not
that the submission passed. This does not establish whether its Raft algorithm
was correct. The previous 900,113 ms timeout remains in history. Raft is not part
of the two-configuration tutorial comparison.

## Evidence: available versus unfinished

| Available now | Not established or not implemented |
| --- | --- |
| Local browser replay JSON and PNG screenshots; live-tested on URL Shortener | Embedded replay player, MP4 export, continuous full-agent video |
| Sandbox logs, assertions and input-integrity reports | Live terminal viewer or terminal video |
| Statistics reproduction results in evaluator reports | Retained statistics plot or browser recording for that task |
| Separate live desktop screenshot/readiness diagnostic | Scored desktop task or continuous desktop recording |
| Raft task, verifier and reference implementation | Successfully verified Raft replication or new post-fix Raft certificate |

Replay uses Solari's CDP default context, release, bounded retrieval, local JSON
redaction and hashing. Missing evidence is labeled honestly. Lifecycle stages are
coarse orchestration labels, not measurements of each remote action.

Command inputs are permission-hardened and checked for mutation after the graph;
this is tamper detection, not an impenetrable multi-tenant filesystem boundary.
The capability-dropped fallback still places offline commands in an isolated
network namespace. If both namespace probes fail, the submission is not executed;
the fallback never silently enables networking.
URL Shortener and Raft explicitly allow evaluator networking.

## External-user validation

**Current evidence: internal runs only; no verified third-party pack adoption.**
The next validation step is one outside engineer trying a task from their own
workflow:

1. Use a clean checkout and Studio to define a small task with an objective check.
2. Run it with their own local credentials and explicit resource budget. Record
   setup friction, the run identity, snapshot digest and evaluator outcome.
3. With their permission, share the credential-free pack and a reviewed result
   summary, including whether the result helped a real decision and whether they
   would use it again.

An independently completed trial establishes initial outside use; repeat usage
and useful decisions are the follow-up evidence to collect. Share packs and
reviewed summaries, never credential stores or raw databases.

## Verification and privacy

Release verification on September 5: 499 tests passed, four skipped; TypeScript,
ESLint and production build passed. The staged-file secret scan and 35 local
documentation links passed checks. No paid runs were started for this release.
In the preceding live batch, URL/statistics artifact downloads returned
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

Update this overview and the setup README when behavior changes. Add dated
verification observations; do not silently rewrite old results.
