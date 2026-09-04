# Agent Providers and Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Codex, executable agent harnesses, Anthropic, and OpenAI-compatible APIs through one lifecycle with named local credentials and normalized live events.

**Architecture:** `AgentProviderRegistry` resolves file-backed agent definitions. Providers implement describe/preflight/plan/execute/cancel, emit a versioned event envelope, and receive only scoped credentials and an isolated tool broker. The Codex provider uses the official server-side TypeScript SDK and its structured `runStreamed()` events; raw APIs share a bounded model/tool loop.

**Tech Stack:** TypeScript 5, Node.js 20+, `@openai/codex-sdk`, Zod 4, native `fetch`, JSONL subprocesses, Vitest 4, Solari SDK adapters.

**Spec:** `docs/superpowers/specs/2026-09-04-custom-agentbench-platform-design.md`

## Global Constraints

- Record provider, resolved model, harness ID/version, reasoning/sampling configuration, tool policy, and benchmark digest separately.
- Provider preflight must not create billable resources.
- Providers receive an allow-listed child environment; benchmark files never contain secrets.
- Sequence all normalized events monotonically per run and redact before persistence/publication.
- Raw model APIs can use local workspace tools and only the Solari primitives approved by the run plan.
- Cancellation must stop active provider work and allow orchestrator resource reconciliation.
- Default tests use fake transports and make no paid calls.
- Follow the official Codex SDK contract documented at `https://learn.chatgpt.com/docs/codex-sdk`: server-side Node.js 18+, `startThread`, structured output, controlled environment, and `runStreamed` async events.

---

### Task 1: Provider lifecycle, identity, events, and registry

**Files:**
- Create: `agentbench-live/src/core/providers/types.ts`
- Create: `agentbench-live/src/core/providers/errors.ts`
- Create: `agentbench-live/src/core/providers/events.ts`
- Create: `agentbench-live/src/core/providers/registry.ts`
- Test: `agentbench-live/tests/providers/registry.test.ts`
- Test: `agentbench-live/tests/providers/events.test.ts`

**Interfaces:**
- Consumes: `AgentDefinition`, `BenchmarkTaskDefinition`, `BenchmarkSnapshot`, `RunPlan`, `DisposableWorkspace`, and `SolariServices`.
- Produces: `AgentProvider`, `AgentProviderRegistry`, `AgentEvent`, `AgentEventSink`, `ProviderExecutionResult`, and typed provider errors.

- [ ] **Step 1: Write failing lifecycle and registry tests**

Test duplicate provider rejection, unknown provider errors, capability lookup,
event sequence assignment, exact-secret redaction, and sink closure after a
terminal provider result.

```ts
it("assigns increasing sequence numbers before publishing", async () => {
  const published: AgentEvent[] = [];
  const sink = createAgentEventSink({
    provider: "fake",
    redact: (value) => value,
    publish: (event) => published.push(event),
    now: () => "2026-09-04T00:00:00.000Z",
  });
  await sink.emit("message", { text: "one" });
  await sink.emit("usage", { inputTokens: 1 });
  expect(published.map((event) => event.sequence)).toEqual([1, 2]);
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd agentbench-live && npm test -- tests/providers/registry.test.ts tests/providers/events.test.ts`

Expected: FAIL because provider modules do not exist.

- [ ] **Step 3: Define the exact provider contract**

```ts
export interface AgentProvider {
  describe(): AgentProviderDescription;
  preflight(input: ProviderPreflightInput): Promise<ProviderPreflightResult>;
  plan(input: ProviderPlanInput, signal: AbortSignal): Promise<RunPlan>;
  execute(
    input: ProviderExecutionInput,
    sink: AgentEventSink,
    signal: AbortSignal,
  ): Promise<ProviderExecution>;
  cancel(handle: ProviderRunHandle): Promise<void>;
}

export type ProviderExecution = {
  handle: ProviderRunHandle;
  result: Promise<ProviderExecutionResult>;
};

export type ProviderRunHandle = { id: string };

export type AgentProviderDescription = {
  id: string;
  name: string;
  adapterVersion: string;
  capabilities: {
    planning: boolean;
    streaming: boolean;
    tools: boolean;
    structuredCompletion: boolean;
  };
  optionsSchema: Record<string, unknown>;
};

export type ProviderExecutionResult = {
  resolvedModel?: string;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  finalResponse?: string;
  nativeTranscript?: string;
};
```

`ProviderExecutionInput` carries agent definition, snapshotted task, validated
plan, disposable workspace, scoped `AgentToolBroker`, and remaining-time
callback. It does not carry raw credential maps.

Providers that can serve model judges also implement:

```ts
export interface StructuredCompletionProvider {
  completeStructured(
    input: StructuredCompletionInput,
    signal: AbortSignal,
  ): Promise<StructuredCompletionResult>;
}

export type StructuredCompletionInput = {
  agent: AgentDefinition;
  system: string;
  prompt: string;
  outputSchema: Record<string, unknown>;
  workingDirectory: string;
};

export type StructuredCompletionResult = {
  resolvedModel?: string;
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  nativeResponse?: unknown;
};
```

`AgentProviderDescription.capabilities.structuredCompletion` declares this
support, and the registry rejects a judge assignment to a provider without it.

- [ ] **Step 4: Implement normalized event sink and typed errors**

Use the spec's event kinds and envelope. Redact payload string leaves before
publishing. `close()` makes later `emit()` throw `ProviderProtocolError` so
late subprocess output cannot mutate a completed run. Define errors with codes
`provider_unavailable`, `provider_incompatible`, `credential_missing`,
`preflight_failed`, `agent_timeout`, and `agent_failed`.

- [ ] **Step 5: Implement registry**

```ts
export class AgentProviderRegistry {
  register(id: string, provider: AgentProvider): void;
  get(id: string): AgentProvider;
  describeAll(): AgentProviderDescription[];
}
```

Normalize provider IDs to lowercase ASCII, reject duplicates, and never select
a fallback provider for an unknown ID.

- [ ] **Step 6: Verify and commit**

Run: `cd agentbench-live && npm test -- tests/providers && npm run typecheck`

```bash
git add agentbench-live/src/core/providers agentbench-live/tests/providers
git commit -m "feat(agentbench): define agent provider lifecycle"
```

### Task 2: Named local credential store

**Files:**
- Create: `agentbench-live/src/core/credentials/types.ts`
- Create: `agentbench-live/src/core/credentials/environment-store.ts`
- Create: `agentbench-live/src/core/credentials/local-file-store.ts`
- Create: `agentbench-live/src/core/credentials/composite-store.ts`
- Create: `agentbench-live/src/core/credentials/redaction.ts`
- Modify: `agentbench-live/.gitignore`
- Modify: `agentbench-live/.env.example`
- Test: `agentbench-live/tests/credentials/store.test.ts`
- Test: `agentbench-live/tests/credentials/redaction.test.ts`

**Interfaces:**
- Consumes: existing `redact` utility.
- Produces: `CredentialStore`, `CredentialMetadata`, `SecretValue`, `EnvironmentCredentialStore`, `LocalFileCredentialStore`, and `CompositeCredentialStore`.

- [ ] **Step 1: Write failing metadata, scope, and leakage tests**

Assert environment names map from explicit configuration, missing references
return false, metadata never includes values, `withCredential` exposes a value
only inside its callback, JSON serialization of `SecretValue` throws, local
credential files must be owner-readable only where the OS exposes modes, and
all known values are redacted from nested provider output.

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd agentbench-live && npm test -- tests/credentials`

Expected: FAIL because credential modules do not exist.

- [ ] **Step 3: Implement credential contracts and environment store**

```ts
export interface CredentialStore {
  listMetadata(): Promise<CredentialMetadata[]>;
  has(ref: string): Promise<boolean>;
  withCredential<T>(
    ref: string,
    use: (secret: SecretValue) => Promise<T>,
  ): Promise<T>;
}

export class SecretValue {
  reveal(): string;
  toJSON(): never;
  toString(): string; // always returns "[REDACTED]"
}
```

Configure environment references with JSON in
`AGENTBENCH_CREDENTIAL_ENV_MAP`, for example
`{"solari-default":"SOLARI_API_KEY","anthropic-primary":"ANTHROPIC_API_KEY"}`.
Validate both reference and variable names; never enumerate unrelated process
environment variables.

- [ ] **Step 4: Implement optional gitignored local file store**

Read `.agentbench/credentials.json` or `AGENTBENCH_CREDENTIAL_FILE`. Accept:

```json
{
  "schemaVersion": 1,
  "credentials": {
    "anthropic-primary": { "value": "secret", "label": "Anthropic" }
  }
}
```

Return only reference, label, source, and configured status as metadata. Add
`.agentbench/`, `.superpowers/`, and the credential filename to `.gitignore`.
Add only variable-name examples to `.env.example`.

- [ ] **Step 5: Implement composite resolution and redaction registration**

Reject duplicate configured references across stores rather than using hidden
precedence. Maintain a process-local exact-value redaction registry populated
only while a secret is in scope; pass a snapshot of exact values to existing
log/event redaction before persistence.

- [ ] **Step 6: Verify and commit**

Run: `cd agentbench-live && npm test -- tests/credentials tests/core/security.test.ts && npm run typecheck`

```bash
git add agentbench-live/src/core/credentials agentbench-live/tests/credentials agentbench-live/.gitignore agentbench-live/.env.example
git commit -m "feat(agentbench): add named local credential store"
```

### Task 3: Codex SDK provider

**Files:**
- Modify: `agentbench-live/package.json`
- Modify: `agentbench-live/package-lock.json`
- Create: `agentbench-live/src/core/providers/codex-sdk.ts`
- Create: `agentbench-live/src/core/providers/codex-events.ts`
- Modify: `agentbench-live/src/core/agents/codex-planner.ts`
- Modify: `agentbench-live/src/core/agents/codex-generator.ts`
- Test: `agentbench-live/tests/providers/codex-sdk.test.ts`
- Test: `agentbench-live/tests/fixtures/codex-sdk/events.jsonl`

**Interfaces:**
- Consumes: `AgentProvider`, `CredentialStore`, existing run-plan schema, and official `Codex`, `Thread`, and streamed event types.
- Produces: `CodexSdkProvider` registered as `codex`; legacy planner/generator remain thin compatibility adapters until Task 7.

- [ ] **Step 1: Install and inspect the official SDK types**

Run: `cd agentbench-live && npm install @openai/codex-sdk && rg -n "runStreamed|outputSchema|workingDirectory|sandboxMode" node_modules/@openai/codex-sdk`

Expected: the installed types expose `Codex`, `startThread`, `run`, and
`runStreamed`. Adjust only property spelling to the installed public types;
preserve the provider interface and behavioral tests below.

- [ ] **Step 2: Write failing provider tests with an injected SDK factory**

Test that planning uses structured output with no Solari MCP config, execution
uses the snapshotted prompt and workspace, the SDK receives an allow-listed
environment, streamed item/turn events normalize in order, usage is returned,
an abort signal stops the thread process, and malformed planning output raises
`plan_invalid` before the execution thread starts.

```ts
const provider = new CodexSdkProvider({
  createCodex: () => fakeCodex,
  environment: () => ({ PATH: "test-path" }),
});
const plan = await provider.plan(input, new AbortController().signal);
expect(plan.primitives).toEqual(["sandbox"]);
expect(fakeCodex.executions).toHaveLength(0);
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `cd agentbench-live && npm test -- tests/providers/codex-sdk.test.ts`

Expected: FAIL because `CodexSdkProvider` does not exist.

- [ ] **Step 4: Implement planning with structured output**

Instantiate `Codex` server-side with an explicitly allow-listed environment.
Start a planning thread using the selected model and reasoning
effort, workspace read-only access, and the generated run-plan JSON Schema.
Call `thread.run(plannerPrompt, { outputSchema })`, parse `finalResponse`, and
reuse `validateRunPlan`. Do not attach Solari MCP configuration to this thread.
Implement `completeStructured` with the same `run(..., { outputSchema })`
mechanism, no MCP configuration, and an explicitly supplied read-only working
directory so Phase 3 model judges can reuse the authenticated local runtime.

- [ ] **Step 5: Implement streamed execution**

Start a new thread with the disposable workspace, workspace-write sandbox,
approved run-scoped Solari MCP configuration, model, and reasoning effort. Call
`runStreamed(taskPrompt)`, iterate `events`, and map item starts/completions,
agent messages, command/tool activity, file changes, warnings, failures, and
turn usage through `codex-events.ts`. Capture the final response without
persisting Codex authentication state in the repository.

- [ ] **Step 6: Keep temporary compatibility adapters**

Make `CodexPlanner` and `CodexGenerator` delegate to shared pure planning/event
translation helpers so their current tests remain green. Mark their direct
composition deprecated in code comments; Task 7 removes them from runtime
composition.

- [ ] **Step 7: Verify and commit**

Run: `cd agentbench-live && npm test -- tests/providers/codex-sdk.test.ts tests/core/codex-adapter.test.ts && npm run typecheck`

```bash
git add agentbench-live/package.json agentbench-live/package-lock.json agentbench-live/src/core/providers agentbench-live/src/core/agents agentbench-live/tests/providers agentbench-live/tests/fixtures/codex-sdk
git commit -m "feat(agentbench): add Codex SDK provider"
```

### Task 4: Isolated workspace and Solari tool broker

**Files:**
- Create: `agentbench-live/src/core/tools/types.ts`
- Create: `agentbench-live/src/core/tools/workspace-tools.ts`
- Create: `agentbench-live/src/core/tools/solari-tools.ts`
- Create: `agentbench-live/src/core/tools/broker.ts`
- Test: `agentbench-live/tests/tools/broker.test.ts`
- Test: `agentbench-live/tests/tools/solari-tools.test.ts`

**Interfaces:**
- Consumes: `DisposableWorkspace`, `RunPlan`, `SolariServices`, `ResourceSupervisor`, and event sink.
- Produces: `AgentToolBroker.listDefinitions()` and `invoke(name, arguments, signal)` for raw providers and executable harnesses.

- [ ] **Step 1: Write failing broker policy tests**

Test local read/list/write/patch/command tools, path traversal rejection,
symlink escape rejection, command timeout/output bounds, unknown tool rejection,
and denial of every Solari primitive absent from `RunPlan.primitives`. Test that
created resources are registered with `ResourceSupervisor` and emit
`resource-created` and `resource-observation` events.

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd agentbench-live && npm test -- tests/tools`

Expected: FAIL because tool broker modules do not exist.

- [ ] **Step 3: Define JSON-schema tool contracts**

Expose `workspace_list`, `workspace_read`, `workspace_write`,
`workspace_apply_patch`, `workspace_exec`, `sandbox_create`, `sandbox_exec`,
`sandbox_preview`, `browser_create`, `browser_goto`, `browser_fill`,
`browser_click`, `browser_text`, `browser_screenshot`, `desktop_create`,
`desktop_exec`, `desktop_open`, `desktop_type`, and `desktop_screenshot`.
Every definition has `additionalProperties: false` and bounded strings/arrays.

- [ ] **Step 4: Implement local workspace tools**

Resolve real paths beneath `workspace.root`, reject symlinks and reserved
credential filenames, cap reads at 1 MiB, writes at 5 MiB, command output at
1 MiB, and individual commands at the smaller of 120 seconds or remaining run
time. Invoke commands without a shell and with the provider allow-listed
environment.

- [ ] **Step 5: Implement Solari tools and resource tracking**

Keep opaque run-local maps from short handles to browser/sandbox/desktop
objects. Never expose API keys. Require the corresponding planned primitive on
every creation and operation. Register cleanup immediately after creation,
capture screenshots as evidence candidates, and close all handles through the
existing supervisor in a `finally` path.

- [ ] **Step 6: Verify and commit**

Run: `cd agentbench-live && npm test -- tests/tools tests/core/solari-supervisor.test.ts && npm run typecheck`

```bash
git add agentbench-live/src/core/tools agentbench-live/tests/tools
git commit -m "feat(agentbench): add isolated agent tool broker"
```

### Task 5: Executable JSONL provider

**Files:**
- Create: `agentbench-live/src/core/providers/executable-jsonl.ts`
- Create: `agentbench-live/src/core/providers/jsonl-protocol.ts`
- Test: `agentbench-live/tests/providers/executable-jsonl.test.ts`
- Create: `agentbench-live/tests/fixtures/providers/fake-jsonl-agent.mjs`

**Interfaces:**
- Consumes: `SpawnCommandRunner`, `AgentToolBroker`, provider lifecycle, and event sink.
- Produces: provider ID `executable-jsonl` using protocol version 1.

- [ ] **Step 1: Write failing protocol tests**

Test handshake, plan request/response, streamed message events, tool request and
result correlation, final result, stderr redaction, malformed JSON, duplicate
request IDs, 1 MiB line limit, timeout, abort, nonzero exit, and process-tree
termination.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd agentbench-live && npm test -- tests/providers/executable-jsonl.test.ts`

Expected: FAIL because the provider does not exist.

- [ ] **Step 3: Define protocol version 1**

The platform writes JSONL messages `initialize`, `plan`, `execute`,
`tool_result`, `cancel`; the harness writes `initialized`, `plan_result`,
`event`, `tool_request`, `result`, `error`. Every message includes
`protocolVersion: 1`; correlated messages include `requestId`. Pass prompt,
policy, workspace path, and model options as data, not command-line arguments.

- [ ] **Step 4: Implement provider and fake harness**

The agent definition supplies `options.command` as a non-empty string array.
Spawn its first item directly with the rest as arguments, `shell: false`, the
workspace as cwd, and an allow-listed environment. Drive tool requests through
the broker sequentially. On cancel, send one cancel message, wait two seconds,
then terminate the process tree.

- [ ] **Step 5: Verify and commit**

Run: `cd agentbench-live && npm test -- tests/providers/executable-jsonl.test.ts && npm run typecheck`

```bash
git add agentbench-live/src/core/providers agentbench-live/tests/providers agentbench-live/tests/fixtures/providers
git commit -m "feat(agentbench): add executable JSONL provider"
```

### Task 6: Anthropic and OpenAI-compatible raw API providers

**Files:**
- Create: `agentbench-live/src/core/providers/model-loop.ts`
- Create: `agentbench-live/src/core/providers/transports/types.ts`
- Create: `agentbench-live/src/core/providers/transports/anthropic.ts`
- Create: `agentbench-live/src/core/providers/transports/openai-compatible.ts`
- Create: `agentbench-live/src/core/providers/raw-api-provider.ts`
- Test: `agentbench-live/tests/providers/model-loop.test.ts`
- Test: `agentbench-live/tests/providers/http-transports.test.ts`

**Interfaces:**
- Consumes: `CredentialStore`, `AgentToolBroker`, provider lifecycle, and native `fetch`.
- Produces: provider IDs `anthropic` and `openai-compatible`; shared `ModelTransport.complete` and bounded `runModelToolLoop`.

- [ ] **Step 1: Write failing transport and tool-loop tests**

Use injected fake `fetch` to assert exact authorization headers, endpoint paths,
model IDs, abort propagation, non-2xx typed errors, malformed responses, usage
normalization, assistant text, tool-call parsing, tool-result round trips, and
that response bodies and errors never contain the credential. Test loop limits
of 100 turns and 500 tool calls.

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd agentbench-live && npm test -- tests/providers/model-loop.test.ts tests/providers/http-transports.test.ts`

Expected: FAIL because transports and loop do not exist.

- [ ] **Step 3: Define provider-neutral messages and transport**

```ts
export interface ModelTransport {
  complete(input: {
    model: string;
    system: string;
    messages: ModelMessage[];
    tools: AgentToolDefinition[];
    signal: AbortSignal;
  }): Promise<ModelTurn>;
}

export type ModelTurn = {
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: unknown }>;
  usage?: { inputTokens?: number; outputTokens?: number };
  finishReason: string;
};
```

- [ ] **Step 4: Implement HTTP transports**

Anthropic uses `POST <baseUrl>/v1/messages`, `x-api-key`, and
`anthropic-version: 2023-06-01`. OpenAI-compatible uses
`POST <baseUrl>/chat/completions` and `Authorization: Bearer`. Require HTTPS
except loopback development URLs. Cap response bodies at 10 MiB, abort on the
run signal, and expose base URL/model only through validated agent options.

- [ ] **Step 5: Implement bounded model/tool loop**

Build the system prompt from the immutable task contract and approved plan.
After each model turn, emit message and usage events, execute tool calls in
declared order, append typed tool results, and continue until a final response.
Reject duplicate call IDs and unknown tools. Stop on 100 turns, 500 tool calls,
remaining-time exhaustion, or abort. Require the submission directory to exist
before returning success.

- [ ] **Step 6: Implement raw provider planning and execution**

Planning calls the same transport with no tools and a strict run-plan JSON
instruction, then validates it locally. Execution resolves only the agent's
named credential inside `withCredential`, creates the transport, runs the tool
loop, and releases the value before returning. Implement
`completeStructured` as one transport call with no tools, the supplied output
schema included in the prompt, and local schema validation of the response.

- [ ] **Step 7: Verify and commit**

Run: `cd agentbench-live && npm test -- tests/providers/model-loop.test.ts tests/providers/http-transports.test.ts tests/credentials && npm run typecheck`

```bash
git add agentbench-live/src/core/providers agentbench-live/tests/providers
git commit -m "feat(agentbench): add raw model API providers"
```

### Task 7: Integrate providers with orchestration and persistence

**Files:**
- Modify: `agentbench-live/src/core/runner/contracts.ts`
- Modify: `agentbench-live/src/core/runner/orchestrator.ts`
- Modify: `agentbench-live/src/core/domain/run.ts`
- Modify: `agentbench-live/src/core/persistence/schema.sql`
- Modify: `agentbench-live/src/core/persistence/migrations.ts`
- Modify: `agentbench-live/src/core/persistence/sqlite-repository.ts`
- Modify: `agentbench-live/src/core/events/run-events.ts`
- Modify: `agentbench-live/src/server/container.ts`
- Modify: `agentbench-live/src/cli.ts`
- Modify: `agentbench-live/tests/core/orchestrator.test.ts`
- Modify: `agentbench-live/tests/integration/pipeline.test.ts`
- Modify: `agentbench-live/tests/integration/cli.test.ts`

**Interfaces:**
- Consumes: provider registry, credential store, tool broker, and file-backed selections.
- Produces: provider-driven orchestration, persisted identity/usage, and normalized SSE events.

- [ ] **Step 1: Write failing provider-driven pipeline tests**

Replace planner/generator fakes with one fake `AgentProvider`. Assert order is
snapshot, provider preflight, plan, workspace, execute, package, verify;
preflight sees metadata but not secrets; execute receives the exact planned
tools; abort invokes cancel once; normalized events are persisted and published
with identical sequence; and different harness IDs produce a comparability
warning.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd agentbench-live && npm test -- tests/core/orchestrator.test.ts tests/integration/pipeline.test.ts`

Expected: FAIL because dependencies still require planner and generator ports.

- [ ] **Step 3: Replace planner/generator dependencies**

Change `OrchestratorDependencies` to provide `providers`, `credentials`,
`createToolBroker`, and `resolveSelection`. Resolve one provider per run; call
its `preflight` and `plan` under existing deadlines, then call `execute`, retain
the returned handle, and await `execution.result` under the generation deadline.
Use one `AbortController`; abort it before `provider.cancel(execution.handle)`
on timeout or user cancellation. Close the event sink before packaging.

- [ ] **Step 4: Persist provider execution identity**

Add migration 3 columns `resolved_model`, `provider_options`, `tool_policy`, and
`usage`. Persist only redacted configuration. Add `provider_event` rows using
the existing event table and keep stage events backward compatible.

- [ ] **Step 5: Compose built-ins and update preflight surfaces**

Register `codex`, `executable-jsonl`, `anthropic`, and `openai-compatible` in
both server and CLI composition. Build the composite credential store once.
Dry run returns provider capability, credential configured status, planned
resources, network use, and maximum duration without revealing values or
creating resources.

- [ ] **Step 6: Remove runtime use of legacy adapters**

Remove `CodexPlanner` and `CodexGenerator` from `container.ts` and `cli.ts`.
Keep their source and focused compatibility tests until the end of this phase,
then delete both source files and replace old tests with provider contract tests
after confirming no imports remain with:

Run: `cd agentbench-live && rg -n "CodexPlanner|CodexGenerator|PlannerPort|GeneratorPort" src tests`

Expected: no matches.

- [ ] **Step 7: Run the complete phase gate**

Run: `cd agentbench-live && npm test && npm run typecheck && npm run lint && npm run build`

Expected: every command PASS; fake provider tests make no paid calls.

- [ ] **Step 8: Commit provider orchestration**

```bash
git add agentbench-live/src agentbench-live/tests
git commit -m "feat(agentbench): orchestrate pluggable agent providers"
```
