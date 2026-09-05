# Custom AgentBench Platform Implementation Roadmap

> Historical design/plan. For shipped behavior, current budgets, verified results
> and known limitations, see the [current implementation guide](../../../agentbench-live/docs/current-state.md).
> This document preserves earlier intent; it is not a release or live certificate.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement the linked plans task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved custom AgentBench platform as four independently testable increments while keeping the existing benchmark runnable after every merge.

**Architecture:** The existing orchestrator, SQLite repository, local queue, Solari adapters, cleanup supervision, and SSE stream remain the spine. Each phase replaces one hardcoded boundary with a strict file-backed or registry-backed contract; compatibility adapters are removed only after regression coverage passes.

**Tech Stack:** TypeScript 5, Node.js 20+, Next.js 16 App Router, React 19, Zod 4, YAML, Vitest 4, SQLite, Solari TypeScript SDKs, OpenAI Codex SDK.

**Spec:** `docs/superpowers/specs/2026-09-04-custom-agentbench-platform-design.md`

## Global Constraints

- Benchmark files are canonical; SQLite may cache discovery only by content digest.
- Every launched run uses an immutable SHA-256 benchmark snapshot.
- Public files contain credential references, never credential values.
- Agent execution and evaluator execution remain isolated.
- Task resource policy allows `browser`, `sandbox`, `desktop`, or any combination; the validated agent plan selects the actual set.
- Enabled evaluator weights total exactly 100.
- An evaluator error or invalid benchmark cannot produce an apparently valid zero score.
- Default tests make no paid provider or Solari calls.
- Preserve the existing URL Shortener and Same Stats tutorial outcomes during migration.
- Before changing Next.js routes or components, read the relevant files under `agentbench-live/node_modules/next/dist/docs/` as required by `agentbench-live/AGENTS.md`.
- Use Node.js 20 or later; the official Codex TypeScript SDK requires Node.js 18 or later.

---

## Ordered Plans

1. [`2026-09-04-custom-agentbench-phase-1-file-backed-domain.md`](./2026-09-04-custom-agentbench-phase-1-file-backed-domain.md)
   replaces hardcoded benchmark and agent definitions with strict YAML packs,
   snapshots, and compatibility lookup. Gate: the current two-task matrix still
   runs using file-backed definitions.
2. [`2026-09-04-custom-agentbench-phase-2-providers.md`](./2026-09-04-custom-agentbench-phase-2-providers.md)
   adds credentials, provider lifecycle, normalized events, Codex SDK, raw API,
   and executable JSONL providers. Gate: deterministic provider contract tests
   and the Codex tutorial baseline pass.
3. [`2026-09-04-custom-agentbench-phase-3-evaluators.md`](./2026-09-04-custom-agentbench-phase-3-evaluators.md)
   replaces task verifiers with weighted evaluator declarations and immutable
   evidence. Gate: all evaluator types pass contract tests and migrated tutorial
   scores match their existing fixtures.
4. [`2026-09-04-custom-agentbench-phase-4-studio.md`](./2026-09-04-custom-agentbench-phase-4-studio.md)
   adds atomic authoring APIs and the three-pane Studio. Gate: a benchmark can
   be created, saved, reloaded, dry-run, and launched entirely from the UI.

Do not begin a later plan until the previous plan's full verification command
passes and its branch has passed code review. Each plan produces working
software on its own and contains its own commit boundaries.
