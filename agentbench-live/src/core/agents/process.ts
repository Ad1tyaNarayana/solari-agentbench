import { spawn, type ChildProcess } from "node:child_process";
import { parseJsonl, type JsonlEvent } from "./jsonl";
import { redact, type RedactionContext } from "@/core/security/redact";

export type CommandSpec = {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  terminationGraceMs?: number;
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

const safeEnvironmentKeys = [
  "APPDATA",
  "CODEX_HOME",
  "ComSpec",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "NODE_EXTRA_CA_CERTS",
  "NODE_ENV",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

export function safeChildEnvironment(
  source: Record<string, string | undefined> = process.env,
  additions: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const environment: Record<string, string> = {};
  for (const key of safeEnvironmentKeys) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(additions)) {
    if (value !== undefined) environment[key] = value;
  }
  return environment as NodeJS.ProcessEnv;
}

function isExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (isExited(child)) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, timeoutMs);
    const onClose = () => finish();
    function finish() {
      clearTimeout(timeout);
      child.removeListener("close", onClose);
      resolve();
    }
    child.once("close", onClose);
  });
}

async function terminateProcessTree(
  child: ChildProcess,
  graceMs: number,
): Promise<void> {
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
  await waitForExit(child, graceMs);
  if (isExited(child)) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
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
        () => void terminateProcessTree(child, spec.terminationGraceMs ?? 1_000),
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
