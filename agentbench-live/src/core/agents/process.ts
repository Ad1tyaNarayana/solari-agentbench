import { spawn, type ChildProcess } from "node:child_process";
import { parseJsonl, type JsonlEvent } from "./jsonl";
import { redact, type RedactionContext } from "@/core/security/redact";

export type CommandSpec = {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  redactionContext?: RedactionContext;
  onEvent?: (event: JsonlEvent) => void;
};

export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  events: JsonlEvent[];
  outputFile?: string;
};

export interface CommandRunner {
  run(spec: CommandSpec): Promise<CommandResult>;
}

function bounded(value: string, addition: string, maximum: number): string {
  if (value.length >= maximum) return value;
  return `${value}${addition}`.slice(0, maximum);
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill",
        ["/pid", String(child.pid), "/t", "/f"],
        { shell: false, windowsHide: true },
      );
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

export class SpawnCommandRunner implements CommandRunner {
  async run(spec: CommandSpec): Promise<CommandResult> {
    const maximum = spec.maxOutputBytes ?? 2 * 1024 * 1024;
    const context = spec.redactionContext ?? {};
    const controller = new AbortController();
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let jsonlBuffer = "";
    const events: JsonlEvent[] = [];

    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env ?? process.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timeout = setTimeout(
        () => {
          timedOut = true;
          controller.abort();
        },
        spec.timeoutMs ?? 15 * 60_000,
      );

      controller.signal.addEventListener(
        "abort",
        () => void terminateProcessTree(child),
        { once: true },
      );

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout = bounded(stdout, text, maximum);
        jsonlBuffer = bounded(jsonlBuffer, text, maximum);
        const lines = jsonlBuffer.split(/\r?\n/);
        jsonlBuffer = lines.pop() ?? "";
        for (const line of lines) {
          for (const event of parseJsonl(line, context)) {
            events.push(event);
            spec.onEvent?.(event);
          }
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = bounded(stderr, chunk.toString("utf8"), maximum);
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (exitCode) => {
        clearTimeout(timeout);
        for (const event of parseJsonl(jsonlBuffer, context)) {
          events.push(event);
          spec.onEvent?.(event);
        }
        resolve({
          exitCode,
          stdout: redact(stdout, context),
          stderr: redact(stderr, context),
          timedOut,
          events,
        });
      });
    });
  }
}
