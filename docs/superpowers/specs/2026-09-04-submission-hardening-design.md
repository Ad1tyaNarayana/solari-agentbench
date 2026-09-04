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

Add `examples/packs/fisher-iris-reproduction`, intentionally outside the bundled tutorial root. The pack cites R. A. Fisher’s 1936 paper, “The Use of Multiple Measurements in Taxonomic Problems,” DOI `10.1111/j.1469-1809.1936.tb02137.x`, and the UCI Iris dataset, DOI `10.24432/C56C76`. The dataset is included with its UCI attribution and CC BY 4.0 notice.

The task asks an agent to implement a dependency-light reproduction that:

- loads the pinned 150-row, four-feature Iris fixture;
- derives a linear discriminant projection from the training data rather than hard-coding labels;
- reports class counts, discriminant coefficients, confusion matrix, accuracy, and the setosa-versus-rest margin;
- emits a methodology document and machine-readable provenance;
- produces byte-stable results when run twice with the declared seed.

Evaluation is 100% deterministic. File and schema evaluators validate the submission contract. A network-disabled command evaluator executes the submitted program twice against the pinned fixture, checks byte equality, independently recomputes the declared metrics, and publishes normalized outputs. Numeric evaluators check the pinned observation/class counts, a minimum leave-one-out accuracy of 0.96, and a strictly positive setosa-versus-rest margin. No model judge contributes points.

The pack is loaded by adding its directory to `AGENTBENCH_BENCHMARK_ROOTS`; it does not receive a special registry path. This proves external discovery rather than adding a third built-in task.

## Certification artifact

Add `agentbench certify --benchmark-root <path> --submission <path> --output <path>`. Certification loads the pack through `BenchmarkLoader`, creates the normal content-addressed snapshot, validates the provider/evaluator declarations, packages the supplied submission with the production policy, and runs the production `EvaluationEngine`. Because the Fisher evaluator executes code, certificate creation requires configured Solari services; `--validate-only` performs snapshot and policy validation without provisioning but does not create a certificate. A completed certification writes a canonical JSON report containing:

- schema version and certification mode;
- benchmark, task, and agent IDs;
- benchmark snapshot and submission digests;
- evaluator versions, results, points, and evidence digests;
- resource/network policy;
- provider/harness identity when agent execution was performed;
- `solariLive: true`, set only after real Solari resource creation and cleanup were observed;
- creation timestamp and repository commit.

The committed Fisher proof is labeled `live-reference-certification`. Unit and integration tests may use fake services, but their output can never be written as a public certificate. The public artifact must not claim an outside user or agent execution; it certifies an externally loaded pack and reference submission through live evaluator infrastructure.

## Studio and production-path proof

Studio remains a canonical-file editor, not a separate benchmark runtime. Create, save, reload, dry-run, and run use the same `AuthoringService`, `BenchmarkLoader`, `BenchmarkCatalog`, `AgentBenchOrchestrator`, and `EvaluationEngine` as CLI-loaded packs.

The current Studio round-trip test stops at `EvaluationEngine`. It will be extended with a deterministic fake provider and fake Solari services to launch the saved pack through `AgentBenchOrchestrator`, then assert that the persisted run’s benchmark digest equals the digest returned by Studio save and that normalized evaluator/evidence records are present. A second integration test loads the Fisher pack solely through an external root and certifies a reference submission.

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

- Fisher, R. A. (1936), “The Use of Multiple Measurements in Taxonomic Problems,” DOI: https://doi.org/10.1111/j.1469-1809.1936.tb02137.x
- Rothamsted Research institutional copy: https://repository.rothamsted.ac.uk/item/9914w/the-use-of-multiple-measurements-in-taxonomic-problems
- UCI Iris dataset and license: https://archive.ics.uci.edu/dataset/53/iris
