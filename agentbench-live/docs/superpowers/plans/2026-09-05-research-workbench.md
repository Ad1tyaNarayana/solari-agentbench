# Research workbench implementation plan

> Historical design/plan. For shipped behavior, current budgets, verified results
> and known limitations, see the [current implementation guide](../../current-state.md).
> This document preserves earlier intent; it is not a release or live certificate.

> Execute inline using superpowers:executing-plans; user requested no delegation.

**Goal:** Make all bundled tasks discoverable and replace the landing-page presentation with a readable local research workbench.

**Architecture:** Keep the canonical pack loader, validated planning, evaluator graph and local credential boundary. Project canonical packs into a shared task library. Keep real results separate from illustrative data. Serve evidence only through run-owned, digest-verified artifacts.

**Tech stack:** Next 16, React 19, TypeScript, Vitest, SQLite, existing Solari SDKs.

**Approved design (revised by user):** Dark neutral developer-tool surfaces, compact task list beside the selected task, restrained accents, no decorative symbols or marketing hero. All three bundled tasks visible. No claims that every run uses every resource or that unresolved live certification has passed.

## Constraints
- Work in the user's D: checkout, on a feature branch; preserve local credentials and review notes.
- No publishing, secrets in output, or silent relaxation of network isolation.
- Local regression tests first for behaviour changes; browser review for presentation.

## Tasks
- [x] Snapshot assets: loaded snapshots contain byte-identical command argv scripts; /benchmark paths resolve securely through the pack loader.
- [x] Task discovery: default catalog resolves Raft and both tutorials; Studio-created packs are also listed with compatible agents.
- [x] Dashboard: duplicate header/hero removed, demos separated from observed results, task budget and contract visible.
- [x] Evidence: run-owned artifact reads enforce ownership, containment, size and digest; generic screenshots and downloadable artifacts render.
- [x] Live updates: persisted event history and refresh on stages; cancellation retained.
- [x] Shared visual system: dashboard, Studio, providers and run detail use the dark theme; responsive CSS included.
- [x] Execution checks: actual redirect assertions, writable build copy, generic cleanup issue persistence. Isolation and replay errors remain explicit.
- [x] Local verification: 67 test files, 463 tests passed, 4 skipped; TypeScript, ESLint and Next production build passed. Desktop browser inspection completed.
- [x] Mobile viewport interaction test: 390px viewport, dashboard task switching and run detail; no document-width overflow observed.
- [ ] Fresh live Solari end-to-end certification and rehearsal.

## Remaining filming blockers

- Browser replay retrieval still has no successful live certificate. No further paid replay experiments were run during this redesign.
- Same Stats requires a network namespace rejected by the previously tested Solari runtime. The task selector now warns about this; network isolation was not silently disabled.
- No embedded live browser framebuffer, desktop viewer or sandbox terminal was added. Event history and saved evidence are distinct from a live resource viewer.
- Coordinator stage labels still advance before the generic evaluator engine executes. They should not be presented as measured remote resource progress.

Changes are local on `feat/research-workbench`; nothing was published or pushed.

## Follow-up: stale updates and failed launches (September 5)

- Original four Luna High failures happened before planning: Next bundled the Codex SDK and broke native CLI executable resolution. Externalized the SDK and added a constructor check to provider preflight; production planning now succeeds.
- Homepage now checks run data every 2.5 seconds and on focus/new-run events. Run detail also has a polling fallback. Stage replay no longer regresses the current stage or repeatedly refreshes on old events.
- Launch feedback prevents accidental duplicate submits and allows explicitly configuring another run. Live provider messages now display their text.
- Fixed default credential filtering dropping the Solari key before execution, and explicitly forward that variable to the Solari MCP process. Planning and unrelated secrets stay excluded.
- Found that the UI smoke test opened the real local database and marked in-flight runs abandoned. Mocked its run-data boundary; a subsequent complete test suite left the live run generating. No change to production singleton storage was needed.
- Cancelled records are now terminal for abandoned-run recovery.
- Live run `c00f9d69-8d24-49a8-b4ad-a9408dc79361` completed generation in 229 seconds but was rejected because its submission contained `dist`. The SDK execution prompt now includes the approved plan, required-file contract, excluded build/cache directories, cleanup guidance and remaining time. The packaging policy remains unchanged; this prompt fix is not itself proof of successful certification.
- Latest local verification: 68 test files, 468 passed, 4 skipped; ESLint passes. Full live certification is tracked separately and must not be inferred from passing unit tests or successful planning.
- Final production retry `40a688de-d1e1-41b2-8623-f70e8f30979d` completed in 232709 ms, scoring 20/100. Results schema and methodology passed; source/package.json was missing, so build/browser were skipped by prerequisites. No infrastructure error or false recovery occurred. Clarified the URL Shortener prompt to show the exact application-root layout and separate scratch builds. This changes future task snapshots; the recorded run keeps its original snapshot. No successful browser certification is claimed.
