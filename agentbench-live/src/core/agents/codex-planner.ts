import { readFile } from "node:fs/promises";
import type { AgentConfig } from "@/core/domain/run";
import { RunPlanSchema, validatePlanForTask, type RunPlan } from "@/core/domain/plan";
import type { TaskManifest } from "@/core/domain/task";
import type { CommandRunner, CommandSpec } from "./process";

export type PlannerInput = {
  agent: AgentConfig;
  task: TaskManifest;
  schemaPath: string;
  outputPath: string;
  plannerPrompt: string;
  timeoutMs: number;
};

export class PlanInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanInvalidError";
  }
}

export class AgentTimeoutError extends Error {
  constructor(message = "Agent process timed out") {
    super(message);
    this.name = "AgentTimeoutError";
  }
}

export class AgentProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentProcessError";
  }
}

function plannerEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.SOLARI_API_KEY;
  return environment;
}

function buildPlannerCommand(
  input: PlannerInput,
  prompt: string,
): CommandSpec {
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
      "--output-schema",
      input.schemaPath,
      "-o",
      input.outputPath,
      prompt,
    ],
    env: plannerEnvironment(),
    timeoutMs: input.timeoutMs,
  };
}

function validate(raw: string, task: TaskManifest): RunPlan {
  const decoded: unknown = JSON.parse(raw);
  const parsed = RunPlanSchema.safeParse(decoded);
  if (!parsed.success) throw new Error(parsed.error.message);
  return validatePlanForTask(parsed.data, task);
}

export class CodexPlanner {
  constructor(private readonly runner: CommandRunner) {}

  async plan(input: PlannerInput): Promise<RunPlan> {
    let prompt = input.plannerPrompt;
    let lastError = "unknown validation error";

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const command = buildPlannerCommand(input, prompt);
      const result = await this.runner.run(command);
      if (result.timedOut) throw new AgentTimeoutError();
      if (result.exitCode !== 0) {
        throw new AgentProcessError(`Planner exited with code ${result.exitCode}`);
      }
      try {
        const output =
          result.outputFile ?? (await readFile(input.outputPath, "utf8"));
        return validate(output, input.task);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        prompt = `${input.plannerPrompt}\n\nPrevious plan was invalid: ${lastError}\nReturn only a corrected plan.`;
      }
    }

    throw new PlanInvalidError(`Planner produced no valid plan: ${lastError}`);
  }
}
