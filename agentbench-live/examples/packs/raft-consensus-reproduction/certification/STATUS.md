# Live certification status

Last checked: 2026-09-05 (Asia/Calcutta).

The reference submission passes the live Solari command evaluator, including the
Raft scenario assertions. The recorded browser executes its action sequence, but
Solari does not return replay evidence after session release and bounded polling.
Certification consequently reports an invalid score and does not issue a live
certificate. This is not a completed certification or an agent-generated result.

The SDK's `BrowserSession.close()` already calls `releaseAndWait`. The evaluator
allows two seconds for recording events to flush before closing, then polls for
replay availability. Further investigation should establish why the recording is
unavailable, including whether recording covers the browser context used by the
SDK. Increasing timeouts alone has not established a solution.

The live checks exposed and fixed missing verifier files in the benchmark
snapshot, CRLF shell entrypoints on Windows, preview health checks dropping the
signed query, and unobserved background command completion on sandbox shutdown.
Solari preview tokens are redacted from public output.

This pack explicitly enables network access because the tested Solari sandbox
does not support the evaluator's nested network namespace. It therefore does not
demonstrate network-isolated reproduction. Network-denied tasks still fail closed
when the runtime cannot provide isolation.

Local verification: 451 tests passed, four skipped; TypeScript, ESLint, and the
Next.js production build passed. The final compute inventory was empty. The
browser inventory endpoint could not be verified, so a global browser-leak claim
is not made. Credentials and raw run evidence remain in Git-ignored local files.
