import type { RunPlan, Primitive } from "@/core/domain/plan";
import type { AgentEventSink } from "@/core/providers/events";
import type {
  BrowserHandle,
  BrowserPageHandle,
  DesktopHandle,
  ExecResult,
  SandboxHandle,
  SolariServices,
} from "@/core/solari/contracts";
import type { ResourceSupervisor } from "@/core/solari/resource-supervisor";
import {
  AgentToolError,
  COMMAND_OUTPUT_MAX_BYTES,
  COMMAND_TIMEOUT_MAX_MS,
  solariToolContracts,
} from "./types";

type SolariToolName = (typeof solariToolContracts)[number]["definition"]["name"];

export type SolariToolsOptions = {
  plan: Pick<RunPlan, "primitives">;
  services: SolariServices;
  supervisor: ResourceSupervisor;
  sink: AgentEventSink;
  remainingMs(): number;
};

type BrowserResource = { resource: BrowserHandle; page: BrowserPageHandle };

function cappedTimeout(
  requested: number | undefined,
  remainingMs: () => number,
  toolName: string,
): number {
  const remaining = Math.floor(remainingMs());
  if (!Number.isFinite(remaining) || remaining <= 0) {
    if (remaining !== Number.POSITIVE_INFINITY) {
      throw new AgentToolError("deadline_exceeded", "No run time remains", {
        toolName,
      });
    }
  }
  return Math.max(
    1,
    Math.min(requested ?? COMMAND_TIMEOUT_MAX_MS, COMMAND_TIMEOUT_MAX_MS, remaining),
  );
}

function boundedExecResult(result: ExecResult): ExecResult & { outputTruncated: boolean } {
  const stdout = Buffer.from(result.stdout, "utf8");
  const acceptedStdout = stdout.subarray(0, COMMAND_OUTPUT_MAX_BYTES);
  const remaining = COMMAND_OUTPUT_MAX_BYTES - acceptedStdout.byteLength;
  const stderr = Buffer.from(result.stderr, "utf8");
  const acceptedStderr = stderr.subarray(0, remaining);
  return {
    exitCode: result.exitCode,
    stdout: acceptedStdout.toString("utf8"),
    stderr: acceptedStderr.toString("utf8"),
    outputTruncated:
      acceptedStdout.byteLength < stdout.byteLength ||
      acceptedStderr.byteLength < stderr.byteLength,
  };
}

async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  toolName: string,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() =>
        reject(
          new AgentToolError("execution_failed", "Solari operation was aborted", {
            toolName,
            cause: signal.reason,
          }),
        ),
      );
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export class SolariTools {
  readonly #planned: ReadonlySet<Primitive>;
  readonly #services: SolariServices;
  readonly #supervisor: ResourceSupervisor;
  readonly #sink: AgentEventSink;
  readonly #remainingMs: () => number;
  readonly #browsers = new Map<string, BrowserResource>();
  readonly #sandboxes = new Map<string, SandboxHandle>();
  readonly #desktops = new Map<string, DesktopHandle>();
  #nextBrowser = 1;
  #nextSandbox = 1;
  #nextDesktop = 1;

  constructor(options: SolariToolsOptions) {
    this.#planned = new Set(options.plan.primitives);
    this.#services = options.services;
    this.#supervisor = options.supervisor;
    this.#sink = options.sink;
    this.#remainingMs = options.remainingMs;
  }

  async invoke(
    name: SolariToolName,
    argumentsValue: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    switch (name) {
      case "sandbox_create":
        return this.#createSandbox(argumentsValue, signal);
      case "sandbox_exec":
        return this.#sandboxExec(argumentsValue, signal);
      case "sandbox_preview":
        return this.#sandboxPreview(argumentsValue, signal);
      case "browser_create":
        return this.#createBrowser(argumentsValue, signal);
      case "browser_goto":
        return this.#browserGoto(argumentsValue, signal);
      case "browser_fill":
        return this.#browserFill(argumentsValue, signal);
      case "browser_click":
        return this.#browserClick(argumentsValue, signal);
      case "browser_text":
        return this.#browserText(argumentsValue, signal);
      case "browser_screenshot":
        return this.#browserScreenshot(argumentsValue, signal);
      case "desktop_create":
        return this.#createDesktop(argumentsValue, signal);
      case "desktop_exec":
        return this.#desktopExec(argumentsValue, signal);
      case "desktop_open":
        return this.#desktopOpen(argumentsValue, signal);
      case "desktop_type":
        return this.#desktopType(argumentsValue, signal);
      case "desktop_screenshot":
        return this.#desktopScreenshot(argumentsValue, signal);
    }
  }

  #requirePrimitive(primitive: Primitive, toolName: string): void {
    if (!this.#planned.has(primitive)) {
      throw new AgentToolError(
        "primitive_not_planned",
        `${primitive} was not included in the validated run plan`,
        { toolName },
      );
    }
  }

  #resource<T>(
    resources: ReadonlyMap<string, T>,
    handle: string,
    toolName: string,
  ): T {
    const resource = resources.get(handle);
    if (resource === undefined) {
      throw new AgentToolError("unknown_handle", "Unknown run-local resource handle", {
        toolName,
      });
    }
    return resource;
  }

  async #emitCreated(primitive: Primitive, handle: string): Promise<void> {
    await this.#sink.emit("resource-created", { primitive, handle });
  }

  async #emitObservation(
    primitive: Primitive,
    handle: string,
    operation: string,
    observation: Record<string, unknown> = {},
  ): Promise<void> {
    await this.#sink.emit("resource-observation", {
      primitive,
      handle,
      operation,
      ...observation,
    });
  }

  async #createSandbox(args: Record<string, unknown>, signal: AbortSignal) {
    const toolName = "sandbox_create";
    this.#requirePrimitive("sandbox", toolName);
    const timeoutMs = cappedTimeout(
      args.timeoutMs as number | undefined,
      this.#remainingMs,
      toolName,
    );
    const sandbox = await this.#services.sandbox.create({ timeoutMs });
    this.#supervisor.trackSandbox(sandbox);
    signal.throwIfAborted();
    const handle = `s-${this.#nextSandbox++}`;
    this.#sandboxes.set(handle, sandbox);
    await this.#emitCreated("sandbox", handle);
    return { handle };
  }

  async #sandboxExec(args: Record<string, unknown>, signal: AbortSignal) {
    const toolName = "sandbox_exec";
    this.#requirePrimitive("sandbox", toolName);
    const handle = args.handle as string;
    const sandbox = this.#resource(this.#sandboxes, handle, toolName);
    const timeoutMs = cappedTimeout(
      args.timeoutMs as number | undefined,
      this.#remainingMs,
      toolName,
    );
    const result = boundedExecResult(
      await abortable(
        sandbox.exec(args.command as string, args.args as string[], {
          ...(args.cwd === undefined ? {} : { cwd: args.cwd as string }),
          timeoutMs,
        }),
        signal,
        toolName,
      ),
    );
    await this.#emitObservation("sandbox", handle, "exec", {
      exitCode: result.exitCode,
      outputTruncated: result.outputTruncated,
    });
    return result;
  }

  async #sandboxPreview(args: Record<string, unknown>, signal: AbortSignal) {
    const toolName = "sandbox_preview";
    this.#requirePrimitive("sandbox", toolName);
    const handle = args.handle as string;
    const sandbox = this.#resource(this.#sandboxes, handle, toolName);
    const preview = await abortable(
      sandbox.previewUrl(args.port as number),
      signal,
      toolName,
    );
    await this.#emitObservation("sandbox", handle, "preview", {
      url: preview.url,
      port: args.port,
    });
    return { url: preview.url };
  }

  async #createBrowser(args: Record<string, unknown>, signal: AbortSignal) {
    const toolName = "browser_create";
    this.#requirePrimitive("browser", toolName);
    const resource = await this.#services.browser.create({
      ...(args.recording === undefined ? {} : { recording: args.recording as boolean }),
      ...(args.stealth === undefined ? {} : { stealth: args.stealth as boolean }),
    });
    this.#supervisor.trackBrowser(resource);
    signal.throwIfAborted();
    const handle = `b-${this.#nextBrowser++}`;
    const page = await abortable(resource.newPage(), signal, toolName);
    this.#browsers.set(handle, { resource, page });
    await this.#emitCreated("browser", handle);
    return { handle };
  }

  async #browserGoto(args: Record<string, unknown>, signal: AbortSignal) {
    const toolName = "browser_goto";
    this.#requirePrimitive("browser", toolName);
    const handle = args.handle as string;
    const { page } = this.#resource(this.#browsers, handle, toolName);
    await abortable(page.goto(args.url as string), signal, toolName);
    const url = page.url();
    await this.#emitObservation("browser", handle, "goto", { url });
    return { url };
  }

  async #browserFill(args: Record<string, unknown>, signal: AbortSignal) {
    const toolName = "browser_fill";
    this.#requirePrimitive("browser", toolName);
    const handle = args.handle as string;
    const { page } = this.#resource(this.#browsers, handle, toolName);
    await abortable(
      page.fill(args.selector as string, args.value as string),
      signal,
      toolName,
    );
    const url = page.url();
    await this.#emitObservation("browser", handle, "fill", { url });
    return { url };
  }

  async #browserClick(args: Record<string, unknown>, signal: AbortSignal) {
    const toolName = "browser_click";
    this.#requirePrimitive("browser", toolName);
    const handle = args.handle as string;
    const { page } = this.#resource(this.#browsers, handle, toolName);
    await abortable(page.click(args.selector as string), signal, toolName);
    const url = page.url();
    await this.#emitObservation("browser", handle, "click", { url });
    return { url };
  }

  async #browserText(args: Record<string, unknown>, signal: AbortSignal) {
    const toolName = "browser_text";
    this.#requirePrimitive("browser", toolName);
    const handle = args.handle as string;
    const { page } = this.#resource(this.#browsers, handle, toolName);
    const text = await abortable(
      page.textContent(args.selector as string),
      signal,
      toolName,
    );
    if (text !== null && Buffer.byteLength(text, "utf8") > COMMAND_OUTPUT_MAX_BYTES) {
      throw new AgentToolError("output_limit", "Browser text exceeds the output limit", {
        toolName,
      });
    }
    const url = page.url();
    await this.#emitObservation("browser", handle, "text", {
      url,
      found: text !== null,
      bytes: text === null ? 0 : Buffer.byteLength(text, "utf8"),
    });
    return { text, url };
  }

  async #browserScreenshot(args: Record<string, unknown>, signal: AbortSignal) {
    const toolName = "browser_screenshot";
    this.#requirePrimitive("browser", toolName);
    const handle = args.handle as string;
    const { page } = this.#resource(this.#browsers, handle, toolName);
    const bytes = await abortable(page.screenshot(), signal, toolName);
    const evidenceCandidate = {
      mediaType: "image/png",
      dataBase64: Buffer.from(bytes).toString("base64"),
    };
    await this.#emitObservation("browser", handle, "screenshot", {
      evidenceCandidate,
    });
    return evidenceCandidate;
  }

  async #createDesktop(args: Record<string, unknown>, signal: AbortSignal) {
    const toolName = "desktop_create";
    this.#requirePrimitive("desktop", toolName);
    const timeoutMs = cappedTimeout(
      args.timeoutMs as number | undefined,
      this.#remainingMs,
      toolName,
    );
    const desktop = await this.#services.desktop.create({
      timeoutMs,
      ...(args.resolution === undefined ? {} : { resolution: args.resolution as string }),
      ...(args.record === undefined ? {} : { record: args.record as boolean }),
    });
    this.#supervisor.trackDesktop(desktop);
    signal.throwIfAborted();
    const handle = `d-${this.#nextDesktop++}`;
    this.#desktops.set(handle, desktop);
    await this.#emitCreated("desktop", handle);
    return { handle };
  }

  async #desktopExec(args: Record<string, unknown>, signal: AbortSignal) {
    const toolName = "desktop_exec";
    this.#requirePrimitive("desktop", toolName);
    const handle = args.handle as string;
    const desktop = this.#resource(this.#desktops, handle, toolName);
    const timeoutMs = cappedTimeout(
      args.timeoutMs as number | undefined,
      this.#remainingMs,
      toolName,
    );
    const result = boundedExecResult(
      await abortable(
        desktop.exec(args.command as string, args.args as string[], {
          ...(args.cwd === undefined ? {} : { cwd: args.cwd as string }),
          timeoutMs,
        }),
        signal,
        toolName,
      ),
    );
    await this.#emitObservation("desktop", handle, "exec", {
      exitCode: result.exitCode,
      outputTruncated: result.outputTruncated,
    });
    return result;
  }

  async #desktopOpen(args: Record<string, unknown>, signal: AbortSignal) {
    const toolName = "desktop_open";
    this.#requirePrimitive("desktop", toolName);
    const handle = args.handle as string;
    const desktop = this.#resource(this.#desktops, handle, toolName);
    const pid = await abortable(
      desktop.open(args.application as string, args.args as string[]),
      signal,
      toolName,
    );
    await this.#emitObservation("desktop", handle, "open", { pid });
    return { pid };
  }

  async #desktopType(args: Record<string, unknown>, signal: AbortSignal) {
    const toolName = "desktop_type";
    this.#requirePrimitive("desktop", toolName);
    const handle = args.handle as string;
    const desktop = this.#resource(this.#desktops, handle, toolName);
    await abortable(desktop.type(args.text as string), signal, toolName);
    await this.#emitObservation("desktop", handle, "type", {
      characters: (args.text as string).length,
    });
    return { typed: true };
  }

  async #desktopScreenshot(args: Record<string, unknown>, signal: AbortSignal) {
    const toolName = "desktop_screenshot";
    this.#requirePrimitive("desktop", toolName);
    const handle = args.handle as string;
    const desktop = this.#resource(this.#desktops, handle, toolName);
    const bytes = await abortable(desktop.screenshot(), signal, toolName);
    const evidenceCandidate = {
      mediaType: "image/png",
      dataBase64: Buffer.from(bytes).toString("base64"),
    };
    await this.#emitObservation("desktop", handle, "screenshot", {
      evidenceCandidate,
    });
    return evidenceCandidate;
  }
}
