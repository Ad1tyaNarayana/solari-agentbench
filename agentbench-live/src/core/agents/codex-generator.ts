import { resolve } from "node:path";
import type { AgentConfig } from "@/core/domain/run";
import type { Primitive, RunPlan } from "@/core/domain/plan";
import type { JsonlEvent } from "./jsonl";
import type { CommandRunner, CommandSpec } from "./process";
import { AgentProcessError, AgentTimeoutError } from "./codex-planner";
import { safeChildEnvironment } from "./process";

export type GeneratorInput = {
  agent: AgentConfig;
  plan: RunPlan;
  taskPrompt: string;
  workspace: { root: string };
  solariApiKey: string;
  timeoutMs: number;
};

export type GenerationResult = {
  stdout: string;
  stderr: string;
  events: JsonlEvent[];
};

const solariToolAllowlists: Record<Primitive, readonly string[]> = {
  browser: [
    "solari_browser_create",
    "solari_browser_profiles",
    "solari_browser_autologin_status",
    "solari_browser_autologin_site",
    "solari_browser_login",
    "solari_browser_save_profile",
    "solari_browser_await_login",
    "solari_browser_navigate",
    "solari_browser_read_page",
    "solari_browser_screenshot",
    "solari_browser_click",
    "solari_browser_type",
    "solari_browser_key",
    "solari_browser_evaluate",
    "solari_browser_replay_url",
    "solari_browser_close",
  ],
  sandbox: [
    "solari_sandbox_create",
    "solari_list",
    "solari_kill",
    "solari_connect",
    "solari_exec",
    "solari_run_command_bg",
    "solari_run_code",
    "solari_read_file",
    "solari_write_file",
    "solari_list_files",
    "solari_get_preview_url",
  ],
  desktop: [
    "solari_desktop_create",
    "solari_list",
    "solari_kill",
    "solari_connect",
    "solari_exec",
    "solari_run_command_bg",
    "solari_run_code",
    "solari_read_file",
    "solari_write_file",
    "solari_list_files",
    "solari_get_preview_url",
    "solari_screenshot",
    "solari_click",
    "solari_type",
    "solari_key",
    "solari_open_app",
  ],
};

const solariCreateTools: Record<Primitive, string> = {
  browser: "solari_browser_create",
  sandbox: "solari_sandbox_create",
  desktop: "solari_desktop_create",
};

export function solariToolsForPrimitives(primitives: Primitive[]): string[] {
  const tools: string[] = [];
  const seen = new Set<string>();
  for (const primitive of primitives) {
    for (const tool of solariToolAllowlists[primitive]) {
      if (!seen.has(tool)) {
        seen.add(tool);
        tools.push(tool);
      }
    }
  }
  return tools;
}

export function solariPrimitivesForTool(toolName: string): Primitive[] {
  const normalized = toolName.startsWith("solari_")
    ? toolName
    : `solari_${toolName}`;
  return (Object.entries(solariToolAllowlists) as Array<
    [Primitive, readonly string[]]
  >)
    .filter(([, tools]) => tools.includes(normalized))
    .map(([primitive]) => primitive);
}

export function buildGeneratorCommand(input: GeneratorInput): CommandSpec {
  const prompt = `${input.taskPrompt}\n\nApproved RunPlan:\n${JSON.stringify(input.plan, null, 2)}\n\nWrite the complete final submission under submission/.`;
  const enabledTools = solariToolsForPrimitives(input.plan.primitives);
  const guardPath = resolve("src/core/agents/solari-mcp-guard.mjs");
  const serverArgs = [
    guardPath,
    input.plan.primitives.map((primitive) => solariCreateTools[primitive]).join(","),
    "npx",
    "-y",
    "@solarisdk/mcp@0.4.3",
  ];
  return {
    command: "codex",
    args: [
      "exec",
      "--ephemeral",
      "--json",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--model",
      input.agent.model,
      "-c",
      `model_reasoning_effort=\"${input.agent.reasoningEffort}\"`,
      "-c",
      `mcp_servers.solari.command=${JSON.stringify(process.execPath)}`,
      "-c",
      `mcp_servers.solari.args=${JSON.stringify(serverArgs)}`,
      "-c",
      `mcp_servers.solari.enabled_tools=${JSON.stringify(enabledTools)}`,
      "--cd",
      input.workspace.root,
      prompt,
    ],
    cwd: input.workspace.root,
    env: safeChildEnvironment(process.env, {
      SOLARI_API_KEY: input.solariApiKey,
    }),
    timeoutMs: input.timeoutMs,
    redactionContext: { localRoots: [input.workspace.root] },
  };
}

export class CodexGenerator {
  constructor(private readonly runner: CommandRunner) {}

  async generate(input: GeneratorInput): Promise<GenerationResult> {
    const result = await this.runner.run(buildGeneratorCommand(input));
    if (result.timedOut) throw new AgentTimeoutError(undefined, result.events);
    if (result.exitCode !== 0) {
      throw new AgentProcessError(
        `Generator exited with code ${result.exitCode}`,
        result.events,
      );
    }
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      events: result.events,
    };
  }
}
