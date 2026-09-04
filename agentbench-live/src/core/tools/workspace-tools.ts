import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { safeChildEnvironment } from "@/core/agents/process";
import type { DisposableWorkspace } from "@/core/security/workspace";
import {
  AgentToolError,
  COMMAND_OUTPUT_MAX_BYTES,
  COMMAND_TIMEOUT_MAX_MS,
  type IsolatedWorkspaceCommandResult,
  type IsolatedWorkspaceCommandRunner,
  WORKSPACE_LIST_MAX_BYTES,
  WORKSPACE_LIST_MAX_ENTRIES,
  WORKSPACE_READ_MAX_BYTES,
  WORKSPACE_WRITE_MAX_BYTES,
  workspaceToolContracts,
} from "./types";

type WorkspaceToolName = (typeof workspaceToolContracts)[number]["definition"]["name"];

export type WorkspaceToolsOptions = {
  workspace: Pick<DisposableWorkspace, "root">;
  remainingMs(): number;
  environment?: Readonly<Record<string, string | undefined>>;
  commandRunner?: IsolatedWorkspaceCommandRunner;
};

// Broker requests are serialized, so untrusted agent operations cannot race
// path validation. Direct mutation by another host process remains a trusted
// operator action and is outside the version-one local threat model.

type PatchOperation =
  | { kind: "add"; path: string; content: string }
  | { kind: "update"; path: string; hunks: PatchHunk[] }
  | { kind: "delete"; path: string };

type PatchHunk = { before: string[]; after: string[] };

const reservedDirectories = new Set([".agentbench", ".codex"]);

function assertAllowedPath(path: string, toolName: string): void {
  if (path.includes("\0")) {
    throw new AgentToolError("path_forbidden", "Workspace paths cannot contain NUL", {
      toolName,
    });
  }
  const segments = path.split(/[\\/]/).filter(Boolean);
  const filename = segments.at(-1)?.toLowerCase() ?? "";
  if (
    segments.some((segment) => {
      const normalized = segment.toLowerCase();
      return (
        reservedDirectories.has(normalized) ||
        /^\.env(?:\.|$)/i.test(normalized) ||
        normalized === "auth.json"
      );
    }) ||
    /^\.env(?:\.|$)/i.test(filename) ||
    filename === "auth.json"
  ) {
    throw new AgentToolError(
      "path_forbidden",
      `Credential paths are reserved: ${path}`,
      { toolName },
    );
  }
}

function assertInside(root: string, candidate: string, toolName: string): void {
  const fromRoot = relative(root, candidate);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new AgentToolError(
      "path_forbidden",
      "Workspace path escapes the workspace root",
      { toolName },
    );
  }
}

function cappedTimeout(
  requested: number | undefined,
  remainingMs: () => number,
  toolName: string,
): number {
  const remaining = Math.floor(remainingMs());
  if (!Number.isFinite(remaining) || remaining <= 0) {
    if (remaining !== Number.POSITIVE_INFINITY) {
      throw new AgentToolError(
        "deadline_exceeded",
        "No run time remains for this command",
        { toolName },
      );
    }
  }
  return Math.max(
    1,
    Math.min(requested ?? COMMAND_TIMEOUT_MAX_MS, COMMAND_TIMEOUT_MAX_MS, remaining),
  );
}

function boundedCommandResult(
  result: IsolatedWorkspaceCommandResult,
): IsolatedWorkspaceCommandResult {
  const stdout = Buffer.from(result.stdout, "utf8");
  const acceptedStdout = stdout.subarray(0, COMMAND_OUTPUT_MAX_BYTES);
  const remaining = COMMAND_OUTPUT_MAX_BYTES - acceptedStdout.byteLength;
  const stderr = Buffer.from(result.stderr, "utf8");
  const acceptedStderr = stderr.subarray(0, remaining);
  return {
    exitCode: result.exitCode,
    stdout: acceptedStdout.toString("utf8"),
    stderr: acceptedStderr.toString("utf8"),
    timedOut: result.timedOut,
    outputTruncated:
      result.outputTruncated ||
      acceptedStdout.byteLength < stdout.byteLength ||
      acceptedStderr.byteLength < stderr.byteLength,
  };
}

function parsePatch(patch: string): PatchOperation[] {
  const lines = patch.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "*** Begin Patch") {
    throw new AgentToolError(
      "invalid_arguments",
      "workspace_apply_patch requires a *** Begin Patch document",
      { toolName: "workspace_apply_patch" },
    );
  }
  const operations: PatchOperation[] = [];
  let index = 1;
  while (index < lines.length && lines[index] !== "*** End Patch") {
    const directive = lines[index];
    if (directive.startsWith("*** Add File: ")) {
      const path = directive.slice("*** Add File: ".length);
      index += 1;
      const content: string[] = [];
      while (index < lines.length && !lines[index].startsWith("*** ")) {
        if (!lines[index].startsWith("+")) {
          throw new AgentToolError(
            "invalid_arguments",
            "Added file lines must start with +",
            { toolName: "workspace_apply_patch" },
          );
        }
        content.push(lines[index].slice(1));
        index += 1;
      }
      operations.push({ kind: "add", path, content: `${content.join("\n")}\n` });
      continue;
    }
    if (directive.startsWith("*** Delete File: ")) {
      operations.push({
        kind: "delete",
        path: directive.slice("*** Delete File: ".length),
      });
      index += 1;
      continue;
    }
    if (directive.startsWith("*** Update File: ")) {
      const path = directive.slice("*** Update File: ".length);
      const hunks: PatchHunk[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("*** ")) {
        if (!lines[index].startsWith("@@")) {
          throw new AgentToolError("invalid_arguments", "Patch hunk must start with @@", {
            toolName: "workspace_apply_patch",
          });
        }
        index += 1;
        const before: string[] = [];
        const after: string[] = [];
        while (
          index < lines.length &&
          !lines[index].startsWith("@@") &&
          !lines[index].startsWith("*** ")
        ) {
          const line = lines[index];
          if (line.startsWith(" ")) {
            before.push(line.slice(1));
            after.push(line.slice(1));
          } else if (line.startsWith("-")) {
            before.push(line.slice(1));
          } else if (line.startsWith("+")) {
            after.push(line.slice(1));
          } else if (line === "\\ No newline at end of file") {
            // The surrounding hunk still describes the desired bytes.
          } else {
            throw new AgentToolError("invalid_arguments", "Invalid patch hunk line", {
              toolName: "workspace_apply_patch",
            });
          }
          index += 1;
        }
        if (before.length === 0 && after.length === 0) {
          throw new AgentToolError("invalid_arguments", "Patch hunk is empty", {
            toolName: "workspace_apply_patch",
          });
        }
        hunks.push({ before, after });
      }
      if (hunks.length === 0) {
        throw new AgentToolError("invalid_arguments", "Updated file has no hunks", {
          toolName: "workspace_apply_patch",
        });
      }
      operations.push({ kind: "update", path, hunks });
      continue;
    }
    throw new AgentToolError("invalid_arguments", "Unknown patch directive", {
      toolName: "workspace_apply_patch",
    });
  }
  if (lines[index] !== "*** End Patch" || operations.length === 0) {
    throw new AgentToolError("invalid_arguments", "Patch is incomplete", {
      toolName: "workspace_apply_patch",
    });
  }
  return operations;
}

function applyHunks(source: string, hunks: PatchHunk[]): string {
  const normalized = source.replaceAll("\r\n", "\n");
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (trailingNewline) lines.pop();
  let searchFrom = 0;
  for (const hunk of hunks) {
    let found = -1;
    for (let candidate = searchFrom; candidate <= lines.length - hunk.before.length; candidate += 1) {
      if (hunk.before.every((line, offset) => lines[candidate + offset] === line)) {
        found = candidate;
        break;
      }
    }
    if (found < 0) {
      throw new AgentToolError("invalid_arguments", "Patch context did not match", {
        toolName: "workspace_apply_patch",
      });
    }
    lines.splice(found, hunk.before.length, ...hunk.after);
    searchFrom = found + hunk.after.length;
  }
  return `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;
}

export class WorkspaceTools {
  readonly #workspace: Pick<DisposableWorkspace, "root">;
  readonly #remainingMs: () => number;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #commandRunner?: IsolatedWorkspaceCommandRunner;

  constructor(options: WorkspaceToolsOptions) {
    this.#workspace = options.workspace;
    this.#remainingMs = options.remainingMs;
    this.#environment = safeChildEnvironment(options.environment ?? process.env);
    this.#commandRunner = options.commandRunner;
  }

  async invoke(
    name: WorkspaceToolName,
    argumentsValue: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    switch (name) {
      case "workspace_list":
        return this.#list(argumentsValue.path as string);
      case "workspace_read":
        return this.#read(argumentsValue.path as string);
      case "workspace_write":
        return this.#write(
          argumentsValue.path as string,
          argumentsValue.content as string,
        );
      case "workspace_apply_patch":
        return this.#applyPatch(argumentsValue.patch as string);
      case "workspace_exec":
        return this.#exec(
          {
            command: argumentsValue.command as string,
            args: argumentsValue.args as string[],
            cwd: argumentsValue.cwd as string | undefined,
            timeoutMs: argumentsValue.timeoutMs as number | undefined,
          },
          signal,
        );
    }
  }

  async #canonicalRoot(): Promise<string> {
    return realpath(this.#workspace.root);
  }

  async #resolveWorkspacePath(
    relativePath: string,
    toolName: WorkspaceToolName,
    allowMissing: boolean,
  ): Promise<{ root: string; absolutePath: string }> {
    assertAllowedPath(relativePath, toolName);
    if (isAbsolute(relativePath)) {
      throw new AgentToolError("path_forbidden", "Absolute workspace paths are forbidden", {
        toolName,
      });
    }
    const root = await this.#canonicalRoot();
    const absolutePath = resolve(root, relativePath);
    assertInside(root, absolutePath, toolName);
    const fromRoot = relative(root, absolutePath);
    let cursor = root;
    for (const segment of fromRoot === "" ? [] : fromRoot.split(sep)) {
      cursor = resolve(cursor, segment);
      try {
        const metadata = await lstat(cursor);
        if (metadata.isSymbolicLink()) {
          throw new AgentToolError(
            "symlink_forbidden",
            `Workspace symlinks are forbidden: ${relativePath}`,
            { toolName },
          );
        }
        assertInside(root, await realpath(cursor), toolName);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) break;
        if (error instanceof AgentToolError) throw error;
        throw new AgentToolError("execution_failed", "Workspace path could not be inspected", {
          toolName,
          cause: error,
        });
      }
    }
    return { root, absolutePath };
  }

  async #list(relativePath: string): Promise<unknown> {
    const toolName = "workspace_list" as const;
    const { root, absolutePath } = await this.#resolveWorkspacePath(
      relativePath,
      toolName,
      false,
    );
    const directory = await stat(absolutePath);
    if (!directory.isDirectory()) {
      throw new AgentToolError("invalid_arguments", "workspace_list path is not a directory", {
        toolName,
      });
    }
    const children = await readdir(absolutePath, { withFileTypes: true });
    if (children.length > WORKSPACE_LIST_MAX_ENTRIES) {
      throw new AgentToolError("output_limit", "Directory listing exceeds entry limit", {
        toolName,
      });
    }
    const entries = [];
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      const childPath = resolve(absolutePath, child.name);
      const listedPath = relative(root, childPath).split(sep).join("/");
      assertAllowedPath(listedPath, toolName);
      const metadata = await lstat(childPath);
      if (metadata.isSymbolicLink()) {
        throw new AgentToolError(
          "symlink_forbidden",
          `Workspace symlinks are forbidden: ${listedPath}`,
          { toolName },
        );
      }
      const type = metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : undefined;
      if (type === undefined) {
        throw new AgentToolError("path_forbidden", "Special workspace entries are forbidden", {
          toolName,
        });
      }
      entries.push({
        path: listedPath,
        type,
        size: metadata.isFile() ? metadata.size : undefined,
      });
    }
    await this.#resolveWorkspacePath(relativePath, toolName, false);
    const result = {
      entries: entries.map((entry) =>
        entry.size === undefined
          ? { path: entry.path, type: entry.type }
          : entry,
      ),
    };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > WORKSPACE_LIST_MAX_BYTES) {
      throw new AgentToolError("output_limit", "Directory listing exceeds byte limit", {
        toolName,
      });
    }
    return result;
  }

  async #read(relativePath: string): Promise<unknown> {
    const toolName = "workspace_read" as const;
    const { absolutePath } = await this.#resolveWorkspacePath(relativePath, toolName, false);
    const metadata = await stat(absolutePath);
    if (!metadata.isFile()) {
      throw new AgentToolError("invalid_arguments", "workspace_read path is not a file", {
        toolName,
      });
    }
    if (metadata.size > WORKSPACE_READ_MAX_BYTES) {
      throw new AgentToolError("output_limit", "Workspace file exceeds the read limit", {
        toolName,
      });
    }
    const contents = await readFile(absolutePath);
    if (contents.includes(0)) {
      throw new AgentToolError("invalid_arguments", "workspace_read supports UTF-8 text only", {
        toolName,
      });
    }
    const content = new TextDecoder("utf-8", { fatal: true }).decode(contents);
    await this.#resolveWorkspacePath(relativePath, toolName, false);
    return { content, bytes: contents.byteLength };
  }

  async #write(relativePath: string, content: string): Promise<unknown> {
    const toolName = "workspace_write" as const;
    const bytes = Buffer.from(content, "utf8");
    if (bytes.byteLength > WORKSPACE_WRITE_MAX_BYTES) {
      throw new AgentToolError("input_limit", "Workspace write exceeds the byte limit", {
        toolName,
      });
    }
    const { absolutePath } = await this.#resolveWorkspacePath(relativePath, toolName, true);
    await mkdir(resolve(absolutePath, ".."), { recursive: true });
    await this.#resolveWorkspacePath(relativePath, toolName, true);
    await writeFile(absolutePath, bytes);
    await this.#resolveWorkspacePath(relativePath, toolName, false);
    return { path: relativePath.replaceAll("\\", "/"), bytes: bytes.byteLength };
  }

  async #applyPatch(patch: string): Promise<unknown> {
    const toolName = "workspace_apply_patch" as const;
    if (Buffer.byteLength(patch, "utf8") > WORKSPACE_WRITE_MAX_BYTES) {
      throw new AgentToolError("input_limit", "Workspace patch exceeds the byte limit", {
        toolName,
      });
    }
    const operations = parsePatch(patch);
    const staged: Array<
      | { kind: "write"; path: string; absolutePath: string; content: string }
      | { kind: "delete"; path: string; absolutePath: string }
    > = [];
    for (const operation of operations) {
      assertAllowedPath(operation.path, toolName);
      if (operation.kind === "add") {
        const { absolutePath } = await this.#resolveWorkspacePath(operation.path, toolName, true);
        staged.push({ kind: "write", path: operation.path, absolutePath, content: operation.content });
      } else {
        const { absolutePath } = await this.#resolveWorkspacePath(operation.path, toolName, false);
        if (operation.kind === "delete") {
          staged.push({ kind: "delete", path: operation.path, absolutePath });
        } else {
          const metadata = await stat(absolutePath);
          if (!metadata.isFile() || metadata.size > WORKSPACE_WRITE_MAX_BYTES) {
            throw new AgentToolError("input_limit", "Patched file exceeds the byte limit", {
              toolName,
            });
          }
          const source = await readFile(absolutePath, "utf8");
          const content = applyHunks(source, operation.hunks);
          if (Buffer.byteLength(content, "utf8") > WORKSPACE_WRITE_MAX_BYTES) {
            throw new AgentToolError("input_limit", "Patched file exceeds the byte limit", {
              toolName,
            });
          }
          staged.push({ kind: "write", path: operation.path, absolutePath, content });
        }
      }
    }
    for (const operation of staged) {
      if (operation.kind === "delete") {
        await rm(operation.absolutePath, { force: false });
        await this.#resolveWorkspacePath(operation.path, toolName, true);
      } else {
        await mkdir(resolve(operation.absolutePath, ".."), { recursive: true });
        await this.#resolveWorkspacePath(operation.path, toolName, true);
        await writeFile(operation.absolutePath, operation.content, "utf8");
        await this.#resolveWorkspacePath(operation.path, toolName, false);
      }
    }
    return { filesChanged: staged.map(({ path }) => path.replaceAll("\\", "/")) };
  }

  async #exec(
    input: { command: string; args: string[]; cwd?: string; timeoutMs?: number },
    signal: AbortSignal,
  ): Promise<unknown> {
    const toolName = "workspace_exec" as const;
    if (this.#commandRunner === undefined) {
      throw new AgentToolError(
        "isolation_unavailable",
        "workspace_exec requires an isolated workspace command runner",
        { toolName },
      );
    }
    const cwd = (
      await this.#resolveWorkspacePath(input.cwd ?? ".", toolName, false)
    ).absolutePath;
    if (!(await stat(cwd)).isDirectory()) {
      throw new AgentToolError("invalid_arguments", "workspace_exec cwd is not a directory", {
        toolName,
      });
    }
    const timeoutMs = cappedTimeout(input.timeoutMs, this.#remainingMs, toolName);
    try {
      const result = boundedCommandResult(
        await this.#commandRunner.run({
          workspaceRoot: await this.#canonicalRoot(),
          workingDirectory: cwd,
          command: input.command,
          args: [...input.args],
          environment: Object.fromEntries(
            Object.entries(this.#environment).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          timeoutMs,
          maxOutputBytes: COMMAND_OUTPUT_MAX_BYTES,
          signal,
        }),
      );
      await this.#resolveWorkspacePath(input.cwd ?? ".", toolName, false);
      return result;
    } catch (error) {
      if (error instanceof AgentToolError) throw error;
      throw new AgentToolError("execution_failed", "Isolated workspace command failed", {
        toolName,
        cause: error,
      });
    }
  }
}
