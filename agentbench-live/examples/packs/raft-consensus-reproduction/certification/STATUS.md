# Raft live certification status

Updated September 6, 2026 after live v1.2.0 verification.

**Both the v1.2.0 reference and a fresh agent submission passed all configured
checks.** The agent scored 100 quality / 39.21 time-adjusted in 765,093 ms.
Reference and agent results are distinct; neither establishes exhaustive protocol
correctness beyond the pinned scenarios and submitted traces.

## September 6: v1.2.0

- Reference: `cert-19ddb7c0-3ebe-4fdf-b196-317ff68bcd80`, 100 quality.
- Agent: `500379cc-3676-489a-8199-2c13d7571b92`, `raft-codex`, 100 quality /
  39.21 time-adjusted. No patched submission or automatic retry.
- Each passed all five evaluators, including 41 command/integrity assertions
  and eight browser assertions. Each retained five artifact references and
  20 browser replay events. Every artifact's size and hash was checked.
- Cleanup issues: zero. Final account inventory: zero browsers, sandboxes, desktops.
- Snapshot: `f13ed8a54149a2d5c347b234b685d988ae9a2e5724d98bc6c848400cb443fc35`.

v1.2.0 clarifies the exact results metadata, scenario operations, trace vocabulary
and summary fields in the agent prompt. The verifier and weights were unchanged.
The old snapshot/results below remain historical, not rescored comparisons.
The reference report names the base runtime commit while the prompt/version
changes were in the working tree; the snapshot digest identifies the task bytes.

Reviewed [reference excerpt](../../../../docs/review-evidence/raft-reference-v1.2.0.json),
[agent excerpt](../../../../docs/review-evidence/raft-agent-v1.2.0.json) and
[screenshot walkthrough](../../../../docs/review-evidence/README.md) exclude signed
URLs and private resource handles. Do not publish the raw local certificate.

## Earlier reference attempt

The reference passed live command/scenario checks, but browser replay could not
be retrieved after release and bounded polling. That attempt remains invalid,
not a completed certificate.

The shared browser adapter now creates recorded sessions, connects through CDP,
uses the default context, releases, and downloads events into the local evidence
store. The September 6 reference certification above subsequently verified this
path on Raft. It does not retroactively change the earlier failed attempt.

## Historical v1.1.0 model attempts

Pack v1.1.0, run `7e5cda2b-544d-4fb6-8765-40e67c466f30`, agent `raft-codex`
(`gpt-5.6-sol`, high reasoning): completed in 592,394 ms with **10 quality / 5.06
time-adjusted**, from static checks only. The results contract failed schema
validation, skipping the independent reproduction and browser checks. The
manifest is empty. Replication remains **unverified**, despite the pipeline's
terminal `completed` status. Zero cleanup issues were reported.

The earlier run `6d9ca115-4a6b-490f-8d0e-55da11b992f0` timed out at 900,113 ms
without an evaluation score. It remains unchanged. The follow-up was the one
approved retry; no submission patch or further retry was used to obtain a pass.

Current policy is a five-minute target / 15-minute cap. The configured verifier
uses deterministic fault/trace checks and a recorded browser, with no model judge.

## Isolation and publication

This pack explicitly enables evaluator networking; it is not an offline
demonstration. The shared evaluator now supports a capability-dropped network
namespace when nested user namespaces are unavailable. Offline tasks still fail
closed if neither supported isolation path works. The fallback keeps offline
commands isolated; it never silently enables networking.

Historical September 5 shared-code checks: 496 tests passed, four skipped; TypeScript, ESLint
and production build passed. Final live inventory checks found zero browsers,
sandboxes and desktops. These checks are not Raft certification. Credentials and
raw local records remain gitignored.

See the [README](../../../../README.md#raft-paper-reproduction-pack) and
[detailed verification](../../../../docs/evidence-verification.md). Re-run the
README's explicit certification workflow before claiming a new certificate.
It provisions billable resources. The September 6 reference and agent attempts
above were explicitly approved and were not automatically retried.
