# AgentBench Live Submission Hardening Design

## Objective

Turn the reviewer feedback into verifiable product and trust improvements without expanding AgentBench Live into a hosted multi-tenant service. The release must state its audience clearly, make command-evaluator inputs tamper-evident, keep deterministic evidence authoritative by default, prove Studio packs use the production pipeline, and publish one externally discovered research-pack certification.

## Product position

AgentBench Live is for engineers, research leads, and hiring teams deciding whether an agent configuration can be trusted with a real workflow. It replaces transcript review and agent self-report with replayable, evaluator-owned evidence, allowing an operator to compare models, prompts, harnesses, and tool policies on the same task and budget.

The project remains a trusted self-hosted operator tool. Hosted identity, tenant isolation, remote secret custody, billing, and untrusted benchmark execution are explicitly out of scope for this submission. The README and landing page will say this directly rather than implying a hosted product.

## Verified baseline and correction

The existing implementation already separates planning from execution, validates every plan before attaching the run-scoped tool broker, creates content-addressed benchmark snapshots, distinguishes assertion failure from evaluator failure, stores redacted evidence by SHA-256 digest, applies resource budgets, confirms matrix cost, and runs Studio-authored evaluator graphs through `EvaluationEngine`.

One README claim is too strong: `/benchmark` and `/submission` are uploaded from immutable source material, but their sandbox copies are writable. The hardening work will make these trees read-only by permissions and tamper-evident by a post-graph integrity seal. Documentation will call them sealed evaluator inputs and explain both controls.

## Sealed command-evaluator inputs

Every command evaluator will build a canonical input manifest before execution. The manifest contains every expected `/benchmark` and `/submission` file path, byte length, and SHA-256 digest. After upload, the evaluator applies `chmod -R a-w` to both trees and registers an integrity finalizer with the evaluator runtime.

Finalizers run after the complete prerequisite graph and before evaluator resources are destroyed. This timing covers background application servers that remain alive for dependent HTTP or browser evaluators. A finalizer enumerates regular files under both roots, hashes their bytes, and compares the complete path set, length, and digest against the manifest. Added, deleted, or changed files fail the owning command evaluator with `status: error`; the final report becomes `invalid-score` with `score: null`. The integrity report is stored as evaluator-owned JSON evidence. `/result` remains writable and is outside the seal.

If permission hardening, enumeration, or hashing is unavailable, the command is not considered safely evaluated and fails closed as an evaluator error. Network isolation remains independent: `network: false` still requires a fresh Linux network namespace before submitted code runs.

## Evidence-first model-judge policy

Each task gains an optional `evaluationPolicy` object:

```yaml
evaluationPolicy:
  maxModelJudgeWeight: 30
  allowModelJudgeMajority: false
```

Defaults are `maxModelJudgeWeight: 30` and `allowModelJudgeMajority: false`. A task whose enabled model-judge weight exceeds the maximum is invalid unless `allowModelJudgeMajority` is explicitly true. Explicit majority opt-in remains useful for inherently subjective tasks, but Studio must show an unavoidable warning and the review screen must report deterministic and model-judge weights separately. The opt-in is canonical benchmark data and therefore part of the snapshot digest and run comparability.

The two bundled tutorial tasks remain 100% deterministic. Their documentation will state that model judges contribute zero points.

## External paper-replication pack

Add `examples/packs/raft-consensus-reproduction`, intentionally outside the bundled tutorial root. The pack cites Diego Ongaro and John Ousterhout’s 2014 USENIX ATC Best Paper, “In Search of an Understandable Consensus Algorithm (Extended Version).” The paper and its bibliography are linked rather than redistributed.

The task asks an agent to build a dependency-light, deterministic five-node Raft simulator that reproduces the paper’s core safety and recovery claims under controlled faults. The submission contract is language-neutral: an executable `run` entry point accepts a scenario JSON path, an integer seed, and an output directory. It must emit canonical `summary.json` and `trace.jsonl` files plus a static HTML trace viewer. The simulator must implement randomized leader election, heartbeats, replicated logs, majority commit, leader failure, node restart, and bidirectional network partitions. It does not need persistence across operating-system process restarts, membership changes, or log compaction.

The pinned scenario corpus covers stable election, leader failover, minority isolation, majority recovery, and divergent-follower log repair. Every trace records logical tick, message or state-transition type, term, node, role, commit index, and log digest. Runs use a logical clock and seeded pseudo-randomness; wall-clock timestamps are forbidden from canonical output. The methodology document identifies the implemented Raft subset and maps each checked invariant to the corresponding paper section.

Evaluation is 100% deterministic. File and schema evaluators validate the submission contract. A network-disabled command evaluator runs every pinned scenario twice with its declared seed, checks byte equality, and independently derives these invariants from the emitted trace and summaries:

- election safety: at most one leader is elected in a term;
- log matching: equal index-and-term entries imply identical prefixes;
- leader completeness: every committed entry is present in every later-term leader;
- state-machine safety: nodes never apply different commands at the same log index;
- quorum behavior: a minority partition cannot commit a new entry, while a recovered majority can elect a leader and resume commits within the scenario’s logical-tick bound.

The evaluator rejects summaries that claim an invariant not supported by the trace, requires all pinned scenarios to reach their expected terminal state, and publishes normalized invariant and liveness results as evaluator-owned evidence. A recorded browser evaluator opens the static trace viewer, selects the failover and partition scenarios, and asserts that term, leader, partition, commit-index, and invariant-status elements match the command evaluator’s normalized results. No model judge contributes points, and the optional desktop resource is not required by this pack.

The pack is loaded by adding its directory to `AGENTBENCH_BENCHMARK_ROOTS`; it does not receive a special registry path. This proves external discovery rather than adding a third built-in task.

## Certification artifact

Add `agentbench certify --benchmark-root <path> --submission <path> --output <path>`. Certification loads the pack through `BenchmarkLoader`, creates the normal content-addressed snapshot, validates the provider/evaluator declarations, packages the supplied submission with the production policy, and runs the production `EvaluationEngine`. Because the Raft evaluator executes code and inspects its trace viewer, certificate creation requires configured Solari sandbox and browser services; `--validate-only` performs snapshot and policy validation without provisioning but does not create a certificate. A completed certification writes a canonical JSON report containing:

- schema version and certification mode;
- benchmark, task, and agent IDs;
- benchmark snapshot and submission digests;
- evaluator versions, results, points, and evidence digests;
- resource/network policy;
- provider/harness identity when agent execution was performed;
- `solariLive: true`, set only after real Solari resource creation and cleanup were observed;
- creation timestamp and repository commit.

The committed Raft proof is labeled `live-reference-certification`. Unit and integration tests may use fake services, but their output can never be written as a public certificate. The public artifact must not claim an outside user or agent execution; it certifies an externally loaded pack and reference submission through live evaluator infrastructure.

## Studio and production-path proof

Studio remains a canonical-file editor, not a separate benchmark runtime. Create, save, reload, dry-run, and run use the same `AuthoringService`, `BenchmarkLoader`, `BenchmarkCatalog`, `AgentBenchOrchestrator`, and `EvaluationEngine` as CLI-loaded packs.

The current Studio round-trip test stops at `EvaluationEngine`. It will be extended with a deterministic fake provider and fake Solari services to launch the saved pack through `AgentBenchOrchestrator`, then assert that the persisted run’s benchmark digest equals the digest returned by Studio save and that normalized evaluator/evidence records are present. A second integration test loads the Raft pack solely through an external root and certifies a reference submission.

## User experience and documentation

The landing page and first README screen will lead with the user and decision, then explain the mechanism. The benchmark section will explicitly say that Studio and external packs use the identical immutable-snapshot and evaluator pipeline. The scoring section will display the deterministic/model-judge split and explain the majority opt-in. The external-pack section will provide one copyable PowerShell and POSIX invocation and link to the paper, UCI dataset, attribution, pack files, and committed certification result.

## Error handling

- Input-tree mutation is an evaluator infrastructure error, never an earned zero.
- A model-judge majority without explicit opt-in is `benchmark_invalid`.
- Missing external pack, submission, fixture, or evaluator assets fail before provisioning.
- Certification never silently falls back from live Solari to fake services, and `--validate-only` never writes a certificate.
- A missing Solari key produces the existing typed `missing_credential` preflight result with `provisioned: false`.
- Certification output and evidence pass through the existing structured credential redaction before persistence.

## Testing and release gate

Development follows red-green TDD. Tests cover permission hardening, foreground and background tampering, file addition/deletion/change, integrity-finalizer failure, invalid-score propagation, judge weights at 0/30/31/100 with and without opt-in, Studio warnings, canonical policy round-trip, external-root discovery, reference certification, exact digest continuity through the orchestrator, and secret absence from certification output.

The release gate is the complete test suite, TypeScript check, ESLint with zero warnings, production Next.js build, `git diff --check`, one no-key smoke preflight, and schema/digest verification of the committed live certification JSON. Volatile fields such as creation time and Solari resource IDs are not expected to reproduce byte-for-byte.

## Sources

- Ongaro, Diego, and John Ousterhout (2014), “In Search of an Understandable Consensus Algorithm (Extended Version),” USENIX ATC ’14: https://www.usenix.org/conference/atc14/technical-sessions/presentation/ongaro
- Official paper PDF: https://www.usenix.org/system/files/conference/atc14/atc14-paper-ongaro.pdf
