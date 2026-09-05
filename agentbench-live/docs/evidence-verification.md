# Live evidence verification — September 5, 2026

This is a dated local verification record, not a public certificate or a promise
that later runs will pass. See [current implementation](current-state.md) for the
product overview and remaining limits. Run IDs refer to the private local database.

## Recording fix and current verification

The browser SDK was updated from installed 0.1.2 to 0.1.3. Its published
change fixes the local proxy keeping Node alive; it does not itself fix replay.
Sandbox/desktop 0.1.2 and MCP 0.4.3 remain the latest checked versions.

The earlier default-context probe used the Playwright wire connection. A live
CDP connection to the same Solari service exposes the default context and
successfully records its pages. The adapter now uses CDP, opens pages in that
context, and releases the session before disconnecting. Failed connections
release the created session. Replay retrieval remains bounded and required.

Diagnostic `5cb415cd-1a5b-405e-9f16-405d7dbef97e` verified this full path:

- Real sandbox rebuild and browser redirect verification in 69.5 seconds.
- Local replay JSON (5,290 bytes), including full DOM snapshots and incremental events.
- Two PNG screenshots, service stdout/stderr, and input-integrity report.
- Zero cleanup issues. The reference still fails the relative-vs-absolute link
  text assertion; it is not presented as a perfect submission or a model run.

Replay NDJSON is downloaded, decoded if gzipped, redacted as JSON, then
content-addressed and included in the run manifest. The UI recognizes this
durable artifact rather than falsely claiming no replay exists. Currently it
offers the JSON download, not an embedded replay player or an MP4 export.

A live isolation probe rejected nested user namespaces (`Invalid argument`)
but successfully created a network-only namespace with no external interfaces
or routes. The evaluator can use that namespace when the user-namespace
probe fails; it never falls back to executing with networking enabled.
The privileged fallback drops all capabilities and enables no-new-privileges.
A live probe confirmed all capability masks were zero and `nsenter` into the
original network namespace was denied.

Desktop diagnostic `a7b1bf49-58ac-4a26-8a72-a1dcf979fab1` saved a real
1280×720 PNG (79,547 bytes) and readiness report. The screenshot was visually
inspected. This tests display capture only, not a task or continuous video.
Reproduce with `node --env-file=.env.local --import tsx scripts/check-desktop.ts --yes`.

## Actual five-minute model batch

- URL Shortener `44169e8f-f30d-43f9-bcaa-89955c763c30`: generation timed out
  at 300 seconds, before independent evaluation.
- Statistics `81b62d76-1d09-4e18-8cb3-ae2d664daa29`: reproduction and all
  numeric checks passed, but a malformed methodology regex invalidated the
  score. The Python-style `(?m)` prefix was removed; the JavaScript `m` flag
  and required headings are unchanged. Regex syntax is now validated early.
- Raft `a82bb2ef-f374-40ba-b38d-a02bf61599f8`: generation timed out at
  300 seconds, before independent evaluation.

The operator approved a new five-minute target / 15-minute hard-cap policy,
with a separate time-adjusted score. Both packs are now v1.1.0 with new
snapshot digests. Historical runs were not changed. See README for the formula.

The first v1.1 statistics attempt (`92a93070-6a02-43a4-b504-fa2550fad4e0`)
stalled during planning. A separate same-model structured-output probe
responded in 7.8 seconds; the stuck attempt was stopped after 448 seconds and
retried once. Its historical `submission_invalid: The operation was aborted`
label is a cancellation-classification bug, not a failed submission. The
orchestrator now preserves the operator cancellation reason when the SDK wraps
it in an `AbortError`; a regression test covers this case.

## Actual extended-budget model batch

URL Shortener `206605e5-7870-4d32-888e-f6926834f595` completed in 342,158 ms:
quality **73.33**, time-adjusted **64.29**. The generated application returned
an HTTP short link from an HTTPS deployment, failing the same-origin check;
the dependent redirect check also failed. This is a submission bug, not an
infrastructure failure. The submission and scores were not patched afterward.

All six artifact routes returned HTTP 200 with matching byte lengths and
SHA-256 digests. The replay contains 21 events; two PNG references, sandbox
stdout/stderr, and an input-integrity report were retained. The two screenshots
have the same digest because the failed same-origin check prevented navigation.
There were zero cleanup issues.

Raft `6d9ca115-4a6b-490f-8d0e-55da11b992f0` hit the 15-minute hard cap
during provider execution (900,113 ms). It has no independent evaluation score
or verifier evidence manifest. Agent messages describe a runtime switch from
Python to Node and a browser check, but those claims are not substituted for
verifier-owned evidence. Zero cleanup issues were reported. This remains a
failed model attempt, not a successful recorded demonstration.

Statistics `df0c80ab-bbae-44f3-b54b-624b5e09595c` completed in 147,598 ms:
quality **100**, time-adjusted **100**. All ten evaluators passed, including
independent reproduction, six numerical checks, and the corrected methodology
regex. The input seal confirms all 16 files were unchanged. All three artifact
routes (integrity report and empty stdout/stderr) returned HTTP 200 with matching
sizes and hashes. No browser evaluator is configured for this task, so this is
sandbox/numerical evidence, not a browser recording or saved plot. Zero cleanup
issues were reported.

Evaluation reports are now credential-redacted at the repository boundary,
including normalized result/assertion tables. Legacy reports are redacted on
read without rescoring or rewriting history. This does not mutate the live
dependency outputs used to open the sandbox preview. Older local database
rows may retain released preview URLs on disk; the database remains gitignored.

## Earlier diagnostic (before the fix)

Reference diagnostic: `2ee04235-59d3-4737-b095-576b7fad81f1`.
This is a fixed reference submission evaluated on real Solari infrastructure,
not a model-generated benchmark result.

Verified in 66 seconds:

- One fresh Solari sandbox rebuilt and served the application.
- One recorded Solari browser visited it and followed the generated short link.
- The destination URL assertion passed.
- Two PNG screenshots were retained and visually inspected.
- Browser assertions, sandbox stdout/stderr, and sealed-input integrity were retained.
- All six artifact routes returned HTTP 200 with the expected content type.
- No resource cleanup failures were reported.

The run remains an evaluator error: replay retrieval was unavailable after
session release and ten bounded attempts. Screenshots and assertions survive
that error now. There was also a real failed fixture assertion: its displayed
short URL was relative, while the configured text assertion expects `http`.
Neither failure was changed to a pass.

A separate recording probe found no pre-existing default browser context, so
switching blindly to `contexts()[0]` is not a valid fix for this deployment.
The SDK adapter was not changed on that assumption.

## Reproduce

From the app directory, with the local Solari key configured:

```powershell
node --env-file=.env.local --import tsx scripts/check-evidence.ts --yes
```

This creates a clearly labeled diagnostic run in the local app and provisions
live resources. It does not call a model, purchase credits, or modify old runs.
Use Node 22 or the configured project runtime.

## Boundaries

- A selected primitive in a RunPlan is intent, not execution evidence.
- Screenshot and log downloads are not a live browser/terminal viewer.
- Desktop capture was not exercised by the earlier URL diagnostic; see the separate new desktop check above.
- The older diagnostic's replay failure remains in its immutable historical record.
- Background service logs are capped at 1 MiB per stream during finalization.
- The empty-state UI no longer claims an expired replay or retained screenshots
  when a run never captured evidence.

Final verification: 496 tests passed, 4 skipped; TypeScript, ESLint and the
production build passed. The rebuilt dashboard displays both scores. The URL
run's screenshots load, its replay artifact is linked, and the run API no longer
exposes raw signed preview tokens. No browser console errors or horizontal
overflow were observed on the checked desktop run page.
