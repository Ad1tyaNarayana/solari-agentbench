# Raft live certification status

Updated September 5, 2026 against the local working tree.

**Raft has not passed end-to-end.** The latest agent attempt earned 10 quality /
5.06 time-adjusted from static checks; results-schema failure skipped reproduction
and browser verification. No successful current live reference certificate has
been established either. The two workflows are tracked separately below.

## Earlier reference attempt

The reference passed live command/scenario checks, but browser replay could not
be retrieved after release and bounded polling. That attempt remains invalid,
not a completed certificate.

The shared browser adapter now creates recorded sessions, connects through CDP,
uses the default context, releases, and downloads events into the local evidence
store. This was verified on URL Shortener, not through a new successful Raft
reference certification. The shared fix does not retroactively certify Raft.

## Latest model attempt

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

Latest shared-code checks: 496 tests passed, four skipped; TypeScript, ESLint
and production build passed. Final live inventory checks found zero browsers,
sandboxes and desktops. These checks are not Raft certification. Credentials and
raw local records remain gitignored.

See [current state](../../../../docs/current-state.md) and
[detailed verification](../../../../docs/evidence-verification.md). Re-run the
README's explicit certification workflow before claiming a new certificate.
It provisions billable resources and was not rerun for this documentation update.
