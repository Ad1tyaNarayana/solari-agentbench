# Solari Cookbook

**AgentBench reviewers: [start with the current-state guide](agentbench-live/docs/current-state.md).** It summarizes demonstrated results, unverified tasks, and current limitations.

[Inspect real browser screenshots and evaluation results](agentbench-live/docs/review-evidence/README.md) without installing anything.

Short, runnable examples for [Solari](https://getsolari.com) — cloud browsers,
sandboxes, and desktops behind one API key.

The upstream cookbook examples below are small, standalone programs.
They are deliberately small: one idea each, no framework, no scaffolding to read
past. Copy one into your project and change the parts you care about.

## AgentBench Live

[AgentBench Live](agentbench-live) is this fork's main project: a local-first, customizable evaluation workbench for engineers choosing models and agent configurations for their own tasks. It separates an agent's claims from independent checks on fresh Solari resources.

The default library has three tasks across two packs: URL Shortener, Same Stats,
Different Graph, and Raft Safety Under Faults. Studio authors custom packs;
providers include local Codex, Anthropic, OpenAI-compatible APIs and executable
JSONL agents. Runs retain SQLite events, evaluator assertions, screenshots and
browser replay JSON. Desktop exploration is optional.

**Verified locally:** Sol and Luna both passed the statistics reproduction checks,
while independent browser checks exposed URL Shortener deployment failures after
agent-reported success. Both scored 100 quality on Statistics and 73.33 on URL
Shortener; Sol was faster in these four same-snapshot samples.

**Raft v1.2.0 now has a passing agent run:** 100 quality / 39.21 time-adjusted
in 12m 45s, including recorded browser verification. A separate reference
certification also scored 100. Earlier failures remain in the history. The
[current-state guide](agentbench-live/docs/current-state.md) includes the timings,
evidence limits and next external-user trial. [Setup](agentbench-live/README.md)
and [verification details](agentbench-live/docs/evidence-verification.md) support it.

## Examples

### Cloud browser

| Example | Language | What it shows |
| --- | --- | --- |
| [browser-quickstart-ts](examples/browser-quickstart-ts) | TypeScript | Launch a browser, open a page, read it |
| [browser-quickstart-py](examples/browser-quickstart-py) | Python | Launch a browser, open a page, read it |
| [browser-stealth-proxy-ts](examples/browser-stealth-proxy-ts) | TypeScript | Stealth mode + residential proxy egress |
| [browser-profiles-ts](examples/browser-profiles-ts) | TypeScript | Log in once, reuse the session forever |
| [browser-session-recording-py](examples/browser-session-recording-py) | Python | Record a session, download the replay |

### Sandbox

| Example | Language | What it shows |
| --- | --- | --- |
| [sandbox-quickstart-ts](examples/sandbox-quickstart-ts) | TypeScript | Run a command, write and read files |
| [sandbox-code-interpreter-py](examples/sandbox-code-interpreter-py) | Python | Stateful Python kernel for agent loops |
| [sandbox-port-preview-ts](examples/sandbox-port-preview-ts) | TypeScript | Expose a server in the VM on a public URL |

### Desktop

| Example | Language | What it shows |
| --- | --- | --- |
| [desktop-computer-use-py](examples/desktop-computer-use-py) | Python | Screenshot, click, and type on a Linux GUI |

## Running an example

Each directory is self-contained.

```bash
git clone https://github.com/solari-sdk/solari-cookbook.git
cd solari-cookbook/examples/browser-quickstart-ts

npm install                          # or: pip install -r requirements.txt
export SOLARI_API_KEY=slr_live_...   # grab one at console.getsolari.com
npm start                            # or: python main.py
```

One `slr_live_` key works across browsers, sandboxes, and desktops, and every
product bills to the same balance.

## Which product do I want?

- **Cloud browser** — you need a *web page*: scraping, testing, filling forms,
  anything Playwright or Puppeteer would do locally. Adds stealth, managed
  proxies, captcha solving, profiles, and session recording.
- **Sandbox** — you need to *run code*: an LLM's Python, an untrusted build, a
  data job. A headless microVM that boots from a snapshot in about a second.
- **Desktop** — you need a *screen*: computer-use agents, GUI apps, anything
  that has to be clicked. A sandbox plus X11 and a live VNC stream.

## Gotchas the examples encode

Things that cost you an afternoon if you meet them cold:

- **TypeScript: call `await solari.close()`.** The browser client keeps a
  loopback proxy open for connection retries. Skip the close and your script
  prints its output and then hangs forever instead of exiting.
- **Recording is per session, not per account.** Pass `recording: true` when you
  create the session; without it the replay endpoint 404s forever. The upload is
  async after release, so poll for ~30s before giving up.
- **Sandbox commands are not shell-interpreted.** `run("ls -la")` looks for a
  binary named `ls -la`. Put argv in `args`, or run `sh -c` explicitly.
- **`kill()`, not `close()`, ends a VM.** `close()` drops your local control
  channel; the VM keeps running until its idle timeout.
- **`timeoutMs` is a rolling idle window**, not a hard deadline — it resets on
  every use.

## Links

- Docs — [docs.getsolari.com](https://docs.getsolari.com)
- Console — [console.getsolari.com](https://console.getsolari.com)
- Changelog — [changelog.getsolari.com](https://changelog.getsolari.com)
- Questions — [hello@getsolari.com](mailto:hello@getsolari.com)

## Contributing

New examples are welcome. Keep them small, make them run end-to-end against the
real API, and put anything surprising in a comment right where it bites.

MIT licensed.
