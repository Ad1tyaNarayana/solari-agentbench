import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { safeChildEnvironment } from "@/core/agents/process";
import { RunPlanSchema, validatePlanForTask, type RunPlan } from "@/core/domain/plan";
import { redact } from "@/core/security/redact";
import {
  AgentFailedError,
  ProviderIncompatibleError,
  ProviderPlanInvalidError,
  ProviderProtocolError,
} from "./errors";
import {
  EXECUTABLE_JSONL_MAX_LINE_BYTES,
  parseHarnessMessage,
  platformMessage,
  type HarnessMessage,
} from "./jsonl-protocol";
import type {
  AgentEventSink,
  AgentProvider,
  AgentProviderDescription,
  ProviderExecution,
  ProviderExecutionInput,
  ProviderExecutionResult,
  ProviderPlanInput,
  ProviderPreflightInput,
  ProviderPreflightResult,
  ProviderRunHandle,
} from "./types";

const commandSchema = z.array(z.string().min(1).max(8192)).min(1).max(65);
const STDERR_MAX_BYTES = 1024 * 1024;
const CANCEL_GRACE_MS = 2_000;

type ActiveExecution = {
  controller: AbortController;
  session?: JsonlProcessSession;
};

function commandFor(input: { agent: ProviderPreflightInput["agent"] }): string[] {
  const parsed = commandSchema.safeParse(input.agent.options.command);
  if (!parsed.success) {
    throw new ProviderIncompatibleError(
      "executable-jsonl",
      "Executable JSONL agents must declare options.command as a non-empty string array",
    );
  }
  if (input.agent.provider.toLowerCase() !== "executable-jsonl") {
    throw new ProviderIncompatibleError(
      "executable-jsonl",
      `Executable JSONL provider cannot run agent ${input.agent.id}`,
    );
  }
  return parsed.data;
}

function validatePlan(value: unknown, input: ProviderPlanInput | ProviderExecutionInput): RunPlan {
  const parsed = RunPlanSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProviderPlanInvalidError(
      "Executable JSONL harness produced an invalid run plan",
      "executable-jsonl",
    );
  }
  try {
    return validatePlanForTask(parsed.data, input.task);
  } catch (error) {
    throw new ProviderPlanInvalidError(
      error instanceof Error ? error.message : "Executable JSONL plan is not allowed",
      "executable-jsonl",
    );
  }
}

function publicAgent(input: ProviderPlanInput | ProviderExecutionInput) {
  const options = { ...input.agent.options };
  delete options.command;
  return {
    id: input.agent.id,
    model: input.agent.model,
    reasoningEffort: input.agent.reasoningEffort,
    harness: input.agent.harness,
    options,
  };
}

function waitForClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveClose) => {
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const onClose = () => finish(true);
    const finish = (closed: boolean) => {
      clearTimeout(timeout);
      child.removeListener("close", onClose);
      resolveClose(closed);
    };
    child.once("close", onClose);
  });
}

async function terminateTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolveKill) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        shell: false,
        windowsHide: true,
      });
      killer.once("error", () => resolveKill());
      killer.once("close", () => resolveKill());
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  if (await waitForClose(child, 250)) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

class JsonlProcessSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly transcript: string[] = [];
  readonly #queue: HarnessMessage[] = [];
  readonly #waiters: Array<{
    resolve(message: HarnessMessage): void;
    reject(error: unknown): void;
  }> = [];
  readonly #context: { localRoots: string[] };
  #buffer = "";
  #stderr = "";
  #failure: unknown;
  #closed = false;

  constructor(command: string[], cwd: string) {
    this.#context = { localRoots: [cwd] };
    this.child = spawn(command[0], command.slice(1), {
      cwd,
      env: safeChildEnvironment(),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const decoder = new StringDecoder("utf8");
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.#buffer += decoder.write(chunk);
      this.#drainLines();
    });
    this.child.stdout.on("end", () => {
      this.#buffer += decoder.end();
      if (this.#buffer.length > 0) this.#consumeLine(this.#buffer);
      this.#buffer = "";
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(this.#stderr) >= STDERR_MAX_BYTES) return;
      this.#stderr = `${this.#stderr}${chunk.toString("utf8")}`.slice(0, STDERR_MAX_BYTES);
    });
    this.child.once("error", () => this.#fail(new AgentFailedError(
      "Executable JSONL harness could not be started",
      "executable-jsonl",
    )));
    this.child.once("close", (code) => {
      this.#closed = true;
      if (code !== 0 && this.#failure === undefined) {
        this.#fail(new AgentFailedError(
          `Executable JSONL harness exited with code ${code ?? "unknown"}`,
          "executable-jsonl",
        ));
      } else if (this.#queue.length === 0 && this.#failure === undefined) {
        this.#fail(new AgentFailedError(
          "Executable JSONL harness exited before completing the request",
          "executable-jsonl",
        ));
      }
    });
  }

  #drainLines(): void {
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      this.#consumeLine(line);
      newline = this.#buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.#buffer) > EXECUTABLE_JSONL_MAX_LINE_BYTES) {
      this.#fail(new ProviderProtocolError(
        "Executable JSONL harness exceeded the 1 MiB line limit",
        "executable-jsonl",
      ));
      void terminateTree(this.child);
    }
  }

  #consumeLine(line: string): void {
    if (!line.trim() || this.#failure !== undefined) return;
    if (Buffer.byteLength(line) > EXECUTABLE_JSONL_MAX_LINE_BYTES) {
      this.#fail(new ProviderProtocolError(
        "Executable JSONL harness exceeded the 1 MiB line limit",
        "executable-jsonl",
      ));
      void terminateTree(this.child);
      return;
    }
    try {
      const message = parseHarnessMessage(line);
      this.transcript.push(redact(line, this.#context));
      const waiter = this.#waiters.shift();
      if (waiter) waiter.resolve(message);
      else this.#queue.push(message);
    } catch (error) {
      this.#fail(error);
      void terminateTree(this.child);
    }
  }

  #fail(error: unknown): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  send(message: Record<string, unknown>): void {
    if (this.#closed || !this.child.stdin.writable) {
      throw new AgentFailedError("Executable JSONL harness stdin is closed", "executable-jsonl");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  next(signal: AbortSignal, timeoutMs: number): Promise<HarnessMessage> {
    signal.throwIfAborted();
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    const queued = this.#queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolveMessage, rejectMessage) => {
      let settled = false;
      const waiter = {
        resolve: (message: HarnessMessage) => finish(() => resolveMessage(message)),
        reject: (error: unknown) => finish(() => rejectMessage(error)),
      };
      const timeout = setTimeout(
        () => waiter.reject(new AgentFailedError("Executable JSONL harness timed out", "executable-jsonl")),
        Math.max(1, timeoutMs),
      );
      const onAbort = () => waiter.reject(signal.reason ?? new Error("aborted"));
      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        complete();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  async cancelAndTerminate(): Promise<void> {
    try {
      this.send(platformMessage("cancel"));
    } catch {
      // The harness may already have closed stdin.
    }
    this.child.stdin.end();
    if (!(await waitForClose(this.child, CANCEL_GRACE_MS))) await terminateTree(this.child);
  }

  async terminate(): Promise<void> {
    this.child.stdin.end();
    if (!(await waitForClose(this.child, 100))) await terminateTree(this.child);
  }
}

async function handshake(
  session: JsonlProcessSession,
  signal: AbortSignal,
  remainingMs: () => number,
  input: ProviderPlanInput | ProviderExecutionInput,
): Promise<void> {
  session.send(platformMessage("initialize", {
    requestId: "initialize-1",
    agent: publicAgent(input),
  }));
  const response = await session.next(signal, remainingMs());
  if (response.type !== "initialized" || response.requestId !== "initialize-1") {
    throw new ProviderProtocolError("Executable JSONL handshake failed", "executable-jsonl");
  }
}

export type ExecutableJsonlProviderOptions = { createHandleId?: () => string };

export class ExecutableJsonlProvider implements AgentProvider {
  readonly #createHandleId: () => string;
  readonly #active = new Map<string, ActiveExecution>();

  constructor(options: ExecutableJsonlProviderOptions = {}) {
    this.#createHandleId = options.createHandleId ?? randomUUID;
  }

  describe(): AgentProviderDescription {
    return {
      id: "executable-jsonl",
      name: "Executable JSONL",
      adapterVersion: "1.0.0",
      capabilities: { planning: true, streaming: true, tools: true, structuredCompletion: false },
      optionsSchema: {
        type: "object",
        properties: {
          command: { type: "array", minItems: 1, maxItems: 65, items: { type: "string" } },
        },
        required: ["command"],
        additionalProperties: false,
      },
    };
  }

  async preflight(input: ProviderPreflightInput): Promise<ProviderPreflightResult> {
    commandFor(input);
    return { ok: true };
  }

  async plan(input: ProviderPlanInput, signal: AbortSignal): Promise<RunPlan> {
    const session = new JsonlProcessSession(commandFor(input), input.snapshot.root);
    try {
      await handshake(session, signal, input.remainingMs, input);
      session.send(platformMessage("plan", {
        requestId: "plan-1",
        task: input.task,
        snapshot: { digest: input.snapshot.digest, root: input.snapshot.root },
      }));
      const response = await session.next(signal, input.remainingMs());
      if (response.type !== "plan_result" || response.requestId !== "plan-1") {
        throw new ProviderProtocolError("Executable JSONL planning response was not correlated", "executable-jsonl");
      }
      return validatePlan(response.plan, input);
    } finally {
      await session.terminate();
    }
  }

  async execute(
    input: ProviderExecutionInput,
    sink: AgentEventSink,
    signal: AbortSignal,
  ): Promise<ProviderExecution> {
    signal.throwIfAborted();
    const plan = validatePlan(input.plan, input);
    const handle: ProviderRunHandle = { id: this.#createHandleId() };
    if (this.#active.has(handle.id)) {
      throw new AgentFailedError("Executable JSONL execution handle collision", "executable-jsonl");
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const active: ActiveExecution = { controller };
    this.#active.set(handle.id, active);
    const result = this.#run(input, plan, sink, active, controller.signal)
      .catch((error: unknown) => {
        if (error instanceof AgentFailedError) throw error;
        throw new AgentFailedError("Executable JSONL execution failed", "executable-jsonl");
      })
      .finally(() => {
        signal.removeEventListener("abort", abort);
        this.#active.delete(handle.id);
      });
    return { handle, result };
  }

  async cancel(handle: ProviderRunHandle): Promise<void> {
    const active = this.#active.get(handle.id);
    if (!active) return;
    if (active.session) await active.session.cancelAndTerminate();
    active.controller.abort(new Error("Executable JSONL execution cancelled"));
  }

  async #run(
    input: ProviderExecutionInput,
    plan: RunPlan,
    sink: AgentEventSink,
    active: ActiveExecution,
    signal: AbortSignal,
  ): Promise<ProviderExecutionResult> {
    const session = new JsonlProcessSession(commandFor(input), input.workspace.root);
    active.session = session;
    const requestIds = new Set<string>();
    try {
      await handshake(session, signal, input.remainingMs, input);
      session.send(platformMessage("execute", {
        requestId: "execute-1",
        task: input.task,
        plan,
        workspace: { root: input.workspace.root },
        tools: input.tools.listDefinitions(),
      }));
      while (true) {
        const message = await session.next(signal, input.remainingMs());
        if (message.type === "event") {
          await sink.emit(message.event.kind, message.event.payload);
          continue;
        }
        if (message.type === "tool_request") {
          if (requestIds.has(message.requestId)) {
            throw new ProviderProtocolError("Executable JSONL harness reused a request ID", "executable-jsonl");
          }
          requestIds.add(message.requestId);
          await sink.emit("tool-request", {
            id: message.requestId,
            tool: message.name,
            arguments: message.arguments,
          });
          try {
            const result = await input.tools.invoke(message.name, message.arguments, signal);
            await sink.emit("tool-result", { id: message.requestId, tool: message.name, result });
            session.send(platformMessage("tool_result", { requestId: message.requestId, result }));
          } catch {
            await sink.emit("tool-result", {
              id: message.requestId,
              tool: message.name,
              error: { message: "Tool execution failed" },
            });
            session.send(platformMessage("tool_result", {
              requestId: message.requestId,
              error: { message: "Tool execution failed" },
            }));
          }
          continue;
        }
        if (message.type === "error") {
          throw new AgentFailedError("Executable JSONL harness reported an error", "executable-jsonl");
        }
        if (message.type === "result" && message.requestId === "execute-1") {
          return { ...message.result, nativeTranscript: session.transcript.join("\n") };
        }
        throw new ProviderProtocolError("Executable JSONL harness emitted an unexpected message", "executable-jsonl");
      }
    } finally {
      await session.terminate();
    }
  }
}
