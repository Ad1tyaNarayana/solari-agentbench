# Raft live certification status

Updated September 5, 2026 against the local working tree.

**No successful current live Raft certificate is established.** Keep reference
certification and model-generated task results separate.

## Earlier reference attempt

The reference passed live command/scenario checks, but browser replay could not
be retrieved after release and bounded polling. That attempt remains invalid,
not a completed certificate.

The shared browser adapter now creates recorded sessions, connects through CDP,
uses the default context, releases, and downloads events into the local evidence
store. This was verified on URL Shortener, not through a new successful Raft
reference certification. The shared fix does not retroactively certify Raft.

## Latest model attempt

Pack v1.1.0, run `6d9ca115-4a6b-490f-8d0e-55da11b992f0`, agent `raft-codex`
(`gpt-5.6-sol`, high reasoning): provider timeout at 900,113 ms before independent
evaluation. No quality score, time-adjusted score or verifier manifest. Agent
messages are not substitutes for those missing results. Zero cleanup issues
were reported.

Current policy is a five-minute target / 15-minute cap. The configured verifier
uses deterministic fault/trace checks and a recorded browser, with no model judge.

## Isolation and publication

This pack explicitly enables evaluator networking; it is not an offline
demonstration. The shared evaluator now supports a capability-dropped network
namespace when nested user namespaces are unavailable. Offline tasks still fail
closed if neither supported isolation path works.

Latest shared-code checks: 496 tests passed, four skipped; TypeScript, ESLint
and production build passed. Final live inventory checks found zero browsers,
sandboxes and desktops. These checks are not Raft certification. Credentials and
raw local records remain gitignored.

See [current state](../../../../docs/current-state.md) and
[detailed verification](../../../../docs/evidence-verification.md). Re-run the
README's explicit certification workflow before claiming a new certificate.
It provisions billable resources and was not rerun for this documentation update.
