import { resolve } from "node:path";
import type { AgentConfig } from "@/core/domain/run";
import type { RunPlan } from "@/core/domain/plan";
import {
  buildLegacyCodexExecutionPrompt,
  solariPrimitivesForTool,
  solariMcpServerDefinition,
  solariToolsForPrimitives,
} from "@/core/providers/codex-sdk";
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

export { solariPrimitivesForTool, solariToolsForPrimitives };

export function buildGeneratorCommand(input: GeneratorInput): CommandSpec {
  const prompt = buildLegacyCodexExecutionPrompt(input.taskPrompt, input.plan);
  const guardPath = resolve("src/core/agents/solari-mcp-guard.mjs");
  const server = solariMcpServerDefinition(input.plan.primitives, guardPath);
  return {
    command: "codex",
    args: [
      "exec",
      "--ephemeral",
      "--json",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--approve-for-me",
      "--model",
      input.agent.model,
      "-c",
      `model_reasoning_effort=\"${input.agent.reasoningEffort}\"`,
      "-c",
      `mcp_servers.solari.command=${JSON.stringify(server.command)}`,
      "-c",
      `mcp_servers.solari.args=${JSON.stringify(server.args)}`,
      "-c",
      `mcp_servers.solari.enabled_tools=${JSON.stringify(server.enabled_tools)}`,
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

/** @deprecated Task 7 removes direct planner/generator runtime composition. */
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
