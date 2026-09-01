import type { AgentConfig, FailureCode } from "@/core/domain/run";
import {
  safeChildEnvironment,
  SpawnCommandRunner,
  type CommandRunner,
} from "./process";

export type PreflightDetailCode =
  | "codex_not_logged_in"
  | "solari_key_missing"
  | "model_unavailable";

export type PreflightResult =
  | { ok: true }
  | { ok: false; failureCode: FailureCode; detailCode: PreflightDetailCode };

type PreflightOptions = {
  runner?: CommandRunner;
  env?: Record<string, string | undefined>;
};

export async function runPreflight(
  agent: AgentConfig,
  options: PreflightOptions = {},
): Promise<PreflightResult> {
  const runner = options.runner ?? new SpawnCommandRunner();
  const environment = options.env ?? process.env;
  if (!environment.SOLARI_API_KEY) {
    return {
      ok: false,
      failureCode: "agent_failed",
      detailCode: "solari_key_missing",
    };
  }
  if (!agent.model.trim()) {
    return {
      ok: false,
      failureCode: "agent_failed",
      detailCode: "model_unavailable",
    };
  }
  const requestedNodeEnvironment = environment.NODE_ENV;
  const nodeEnvironment =
    requestedNodeEnvironment === "production" ||
    requestedNodeEnvironment === "test" ||
    requestedNodeEnvironment === "development"
      ? requestedNodeEnvironment
      : "development";
  const commandEnvironment = safeChildEnvironment(environment, {
    NODE_ENV: nodeEnvironment,
  });

  const login = await runner.run({
    command: "codex",
    args: ["login", "status"],
    env: commandEnvironment,
    timeoutMs: 30_000,
  });
  if (login.timedOut || login.exitCode !== 0) {
    return {
      ok: false,
      failureCode: "agent_failed",
      detailCode: "codex_not_logged_in",
    };
  }

  const model = await runner.run({
    command: "codex",
    args: [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--model",
      agent.model,
      "Reply exactly: OK",
    ],
    env: commandEnvironment,
    timeoutMs: 60_000,
  });
  if (model.timedOut || model.exitCode !== 0) {
    return {
      ok: false,
      failureCode: "agent_failed",
      detailCode: "model_unavailable",
    };
  }
  return { ok: true };
}
