# AgentBench review and recording walkthrough

Updated September 6, 2026 after live Raft verification. This supersedes the
earlier review against c25e24c. See [current state](docs/current-state.md) and
[verification details](docs/evidence-verification.md). This is not a certificate.

Lead the recording with the demonstrated result: the browser evaluator caught a
deployment failure after agent-reported success, and both configurations passed
the statistics checks. Raft v1.2.0 now has a passing agent run and a separate
passing reference certification, with browser evidence. Save implementation limits for
the relevant chapter rather than opening with a list of caveats.

## Start the local app

Project: `D:\aditya\code\solari-agentbench\agentbench-live`.

```powershell
Set-Location D:\aditya\code\solari-agentbench\agentbench-live
$runtimeDir = 'D:\aditya\code\.agentbench-runtime\node-v22.23.2-win-x64'
$env:Path = $runtimeDir + ';' + $env:Path
npm run build
npm start -- --hostname 127.0.0.1
```

Open <http://127.0.0.1:3000>. Use `npm run dev -- --hostname 127.0.0.1` while
editing. Do not rebuild/restart during live jobs. The local Node 22 runtime
matches SQLite's installed binary. Other checkouts should follow the
[setup README](README.md). Never open `.env.local` while recording.

## Page tour

| Page | Implemented behavior | How to explain it |
| --- | --- | --- |
| `/` | Dark task workbench, three default tasks, per-pack agents, both scores, live refresh | Synthetic records are excluded; an empty table links to an example run |
| `/studio` | Authoring, YAML preview, validation, save/reopen, task and agent selection | Same snapshot/evaluator pipeline; selected runs, not a full UI matrix |
| `/providers` | Capabilities and credential-reference metadata | An adapter listing is not verified connectivity |
| `/runs/[id]` | Plan, lifecycle, persisted messages, scores, assertions, artifact links and screenshots | Planned primitives and agent claims are not verifier evidence |

Studio supports file, schema, command, HTTP, browser, numeric and model-judge
checks. Resource permissions do not force all primitives to be used. Use the
CLI matrix for multi-configuration comparisons. If Raft is missing, check
`AGENTBENCH_BENCHMARK_ROOTS`: empty/unset selects both shipped packs.

## What happens in a run

1. Resolve canonical pack files into a content-addressed snapshot.
2. Queue provider preflight and a planning-only model call.
3. Validate the RunPlan before attaching permitted Solari tools.
4. Generate, package and scan the submission.
5. Independently rebuild/reproduce it on fresh verifier resources.
6. Grade assertions; infrastructure errors invalidate the score.
7. Save evidence, clean resources, and publish final timing. SSE plus polling
   and focus refreshes update the page.

The five-minute target is not the cutoff: work can continue up to 15 minutes.
Time-adjusted score is quality × min(1, 5 / elapsed minutes), rounded to two
decimals. Timing includes planning through cleanup, not queue time. An incomplete
timeout has no valid quality score. Stages are coarse orchestration labels.

## Real results to review

- [Statistics](http://127.0.0.1:3000/runs/df0c80ab-bbae-44f3-b54b-624b5e09595c):
  100 quality / 100 time-adjusted in 2m 28s. All ten evaluators passed. Show
  recomputed values and integrity; no saved plot or browser video exists.
- [URL Shortener](http://127.0.0.1:3000/runs/206605e5-7870-4d32-888e-f6926834f595):
  73.33 quality / 64.29 time-adjusted in 5m 42s. Show the HTTP/HTTPS link
  failure, screenshots, replay JSON and sandbox logs.
- [Raft v1.2.0](http://127.0.0.1:3000/runs/500379cc-3676-489a-8199-2c13d7571b92):
  100 quality / 39.21 time-adjusted in 12m 45s. All five evaluators passed,
  including 41 command/integrity assertions and eight browser assertions.
  Show the trace-viewer PNG and replay metadata. This is an agent run, separate
  from the reference certification. It covers the pinned scenarios, not all Raft.
- [Historical Raft v1.1.0 follow-up](http://127.0.0.1:3000/runs/7e5cda2b-544d-4fb6-8765-40e67c466f30):
  10 quality / 5.06 time-adjusted in 9m 52s, from static checks only. Results
  schema failure skipped reproduction and browser capture. That submission remains
  unverified; “completed” does not mean “passed.” The earlier timeout remains
  visible in the run history.

These URLs require this machine's local database. They are not public evidence
links on a fresh checkout. Old snapshots/outcomes remain unchanged.

The follow-up now completes the tutorial's four-cell configuration comparison:
[Luna URL](http://127.0.0.1:3000/runs/7442a84e-f733-4cd9-98b6-15a5556c3de0)
earned 73.33 quality / 52.89 time-adjusted in 6m 56s, and
[Luna Statistics](http://127.0.0.1:3000/runs/8d934b6e-f311-42a8-87da-9af2002d6a1c)
earned 100 / 88.95 in 5m 37s. Both pin the Sol baseline snapshot. Show these
alongside Sol's results: equal quality, Sol faster in these single observations.
Model and reasoning effort both differ; do not call this a universal model ranking.

## Fixed since the original walkthrough

- Verifier assets are included in snapshots; URL redirect checks now run.
- Production Codex SDK/native executable resolution works.
- Capability-dropped network isolation was live-verified; unsupported offline
  execution still fails closed.
- Browser verification uses the CDP recording context and saves replay JSON.
- Manifest screenshots and integrity-checked artifact routes are displayed.
- Missing evidence is no longer described as an expired recording.
- Whole-page live refresh and persisted event history are implemented.
- Saved Studio packs reopen; a launch selects an agent explicitly.
- Statistics methodology regex and wrapped cancellation classification are fixed.
  The old stopped attempt's incorrect failure label remains historical.

## Filming boundaries

There is no embedded live browser framebuffer, desktop/VNC viewer, sandbox
terminal, replay player or MP4 export. Replay JSON is not a watchable video.
To show inner workings, record an actual authorized Solari viewer alongside the
dashboard while resources are alive. Do not imply the app supplies that viewer.
A separate desktop diagnostic proves PNG capture only.

`dry-run` calls the model but creates no Solari resources. `certify` evaluates an
existing submission, not agent generation or a normal dashboard run.
`demo:seed` produces synthetic data, not a live-result export. Earlier video
files have not been revalidated for this build.

## Suggested recording sequence

1. Introduce the benchmark task and the workflow being evaluated.
2. Show the prompt, evaluator weights, resource policy and snapshot identity.
3. Show provider/model and five-minute target / 15-minute cap.
4. Start a real run; capture the app and a real resource viewer if available.
5. Contrast the agent's completion message with independent assertions.
6. Inspect a specific success or failure, both scores and saved artifacts.
7. Show cleanup and the public repository; name remaining limitations.

Keep waiting and failures in the full footage; label accelerated sections.
Do not splice reference diagnostics into model runs or claim a universal winner.
Review images/logs before publication. Keep keys, signed viewer URLs, account
details and raw databases off screen. Your voiceover can be recorded separately.
