import type { AgentConfig } from "@/core/domain/run";
import type { RunPlan } from "@/core/domain/plan";
import type { JsonlEvent } from "./jsonl";
import type { CommandRunner, CommandSpec } from "./process";
import { AgentProcessError, AgentTimeoutError } from "./codex-planner";

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

export function buildGeneratorCommand(input: GeneratorInput): CommandSpec {
  const prompt = `${input.taskPrompt}\n\nApproved RunPlan:\n${JSON.stringify(input.plan, null, 2)}\n\nWrite the complete final submission under submission/.`;
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
      'mcp_servers.solari.command="npx"',
      "-c",
      'mcp_servers.solari.args=["-y","@solarisdk/mcp"]',
      "--cd",
      input.workspace.root,
      prompt,
    ],
    cwd: input.workspace.root,
    env: { ...process.env, SOLARI_API_KEY: input.solariApiKey },
    timeoutMs: input.timeoutMs,
    redactionContext: { localRoots: [input.workspace.root] },
  };
}

export class CodexGenerator {
  constructor(private readonly runner: CommandRunner) {}

  async generate(input: GeneratorInput): Promise<GenerationResult> {
    const result = await this.runner.run(buildGeneratorCommand(input));
    if (result.timedOut) throw new AgentTimeoutError();
    if (result.exitCode !== 0) {
      throw new AgentProcessError(`Generator exited with code ${result.exitCode}`);
    }
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      events: result.events,
    };
  }
}
