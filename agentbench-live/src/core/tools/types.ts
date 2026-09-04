import { z } from "zod";
import type { AgentToolDefinition } from "@/core/providers/types";

export const WORKSPACE_READ_MAX_BYTES = 1024 * 1024;
export const WORKSPACE_WRITE_MAX_BYTES = 5 * 1024 * 1024;
export const WORKSPACE_LIST_MAX_ENTRIES = 1000;
export const WORKSPACE_LIST_MAX_BYTES = 64 * 1024;
export const COMMAND_OUTPUT_MAX_BYTES = 1024 * 1024;
export const COMMAND_TIMEOUT_MAX_MS = 120_000;
export const SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
export const SCREENSHOT_BASE64_MAX_BYTES = Math.ceil(SCREENSHOT_MAX_BYTES / 3) * 4;

export type AgentToolErrorCode =
  | "unknown_tool"
  | "invalid_arguments"
  | "path_forbidden"
  | "symlink_forbidden"
  | "input_limit"
  | "output_limit"
  | "deadline_exceeded"
  | "isolation_unavailable"
  | "execution_failed"
  | "primitive_not_planned"
  | "resource_tracking_failed"
  | "unknown_handle";

export class AgentToolError extends Error {
  readonly code: AgentToolErrorCode;
  readonly toolName?: string;

  constructor(
    code: AgentToolErrorCode,
    message: string,
    options: { toolName?: string; cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "AgentToolError";
    this.code = code;
    this.toolName = options.toolName;
  }
}

export type IsolatedWorkspaceCommandInput = {
  workspaceRoot: string;
  workingDirectory: string;
  command: string;
  args: string[];
  environment: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
};

export type IsolatedWorkspaceCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
};

/**
 * Explicit security boundary for local workspace commands.
 *
 * Implementations MUST use OS or remote isolation that exposes only
 * `workspaceRoot`, disables network access, injects only `environment`, caps
 * output, and terminates the full process tree on timeout or abort. An ordinary
 * host child-process runner does not satisfy this contract.
 */
export interface IsolatedWorkspaceCommandRunner {
  run(input: IsolatedWorkspaceCommandInput): Promise<IsolatedWorkspaceCommandResult>;
}

export type ToolContract<T extends Record<string, unknown> = Record<string, unknown>> = {
  definition: AgentToolDefinition;
  argumentsSchema: z.ZodType<T>;
};

const path = z.string().min(1).max(1024);
const handle = z.string().min(1).max(64);
const command = z.string().min(1).max(1024);
const commandArgs = z.array(z.string().max(8192)).max(64).default([]);
const timeoutMs = z.number().int().min(1).max(COMMAND_TIMEOUT_MAX_MS).optional();
const selector = z.string().min(1).max(2048);

function contract<T extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: T,
): ToolContract<z.infer<z.ZodObject<T>>> {
  const argumentsSchema = z.object(shape).strict();
  return {
    definition: {
      name,
      description,
      inputSchema: z.toJSONSchema(argumentsSchema, { target: "draft-7" }),
    },
    argumentsSchema,
  };
}

export const workspaceToolContracts = [
  contract("workspace_list", "List one directory inside the run workspace.", {
    path: path.optional().default("."),
  }),
  contract("workspace_read", "Read one UTF-8 file inside the run workspace.", {
    path,
  }),
  contract("workspace_write", "Write one UTF-8 file inside the run workspace.", {
    path,
    content: z.string().max(WORKSPACE_WRITE_MAX_BYTES),
  }),
  contract(
    "workspace_apply_patch",
    "Apply a bounded Begin Patch document to files inside the run workspace.",
    { patch: z.string().min(1).max(WORKSPACE_WRITE_MAX_BYTES) },
  ),
  contract("workspace_exec", "Execute a program without a shell in the run workspace.", {
    command,
    args: commandArgs,
    cwd: path.optional(),
    timeoutMs,
  }),
] as const;

export const solariToolContracts = [
  contract("sandbox_create", "Create a planned run-scoped Solari sandbox.", {
    timeoutMs,
  }),
  contract("sandbox_exec", "Execute a program in a run-scoped Solari sandbox.", {
    handle,
    command,
    args: commandArgs,
    cwd: path.optional(),
    timeoutMs,
  }),
  contract("sandbox_preview", "Get a token-free preview URL for a sandbox port.", {
    handle,
    port: z.number().int().min(1).max(65_535),
  }),
  contract("browser_create", "Create a planned run-scoped Solari browser.", {
    recording: z.boolean().optional(),
    stealth: z.boolean().optional(),
  }),
  contract("browser_goto", "Navigate a run-scoped browser page.", {
    handle,
    url: z.string().url().max(8192),
  }),
  contract("browser_fill", "Fill a field in a run-scoped browser page.", {
    handle,
    selector,
    value: z.string().max(256 * 1024),
  }),
  contract("browser_click", "Click an element in a run-scoped browser page.", {
    handle,
    selector,
  }),
  contract("browser_text", "Read element text from a run-scoped browser page.", {
    handle,
    selector,
  }),
  contract("browser_screenshot", "Capture browser PNG evidence.", { handle }),
  contract("desktop_create", "Create a planned run-scoped Solari desktop.", {
    timeoutMs,
    resolution: z.string().min(3).max(32).regex(/^\d{2,5}x\d{2,5}$/).optional(),
    record: z.boolean().optional(),
  }),
  contract("desktop_exec", "Execute a program in a run-scoped Solari desktop.", {
    handle,
    command,
    args: commandArgs,
    cwd: path.optional(),
    timeoutMs,
  }),
  contract("desktop_open", "Open an application in a run-scoped desktop.", {
    handle,
    application: z.string().min(1).max(256),
    args: commandArgs,
  }),
  contract("desktop_type", "Type bounded text in a run-scoped desktop.", {
    handle,
    text: z.string().max(256 * 1024),
  }),
  contract("desktop_screenshot", "Capture desktop PNG evidence.", { handle }),
] as const;

export const allToolContracts: readonly ToolContract[] = [
  ...workspaceToolContracts,
  ...solariToolContracts,
];

export function parseToolArguments(
  tool: ToolContract,
  value: unknown,
): Record<string, unknown> {
  const parsed = tool.argumentsSchema.safeParse(value);
  if (!parsed.success) {
    throw new AgentToolError(
      "invalid_arguments",
      `Invalid arguments for ${tool.definition.name}: ${parsed.error.message}`,
      { toolName: tool.definition.name },
    );
  }
  return parsed.data;
}
