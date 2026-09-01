import { expect, test } from "vitest";
import type { RunPlan } from "@/core/domain/plan";
import { RunEventBus } from "@/core/events/run-events";
import { SqliteRunRepository } from "@/core/persistence/sqlite-repository";
import type { DisposableWorkspace } from "@/core/security/workspace";
import { AgentBenchOrchestrator } from "@/core/runner/orchestrator";
import { runMatrix } from "@/core/runner/matrix";
import { agents, getAgent, listTasks } from "@/core/tasks/registry";

test("runs the complete two-agent by two-task matrix with concurrency one", async () => {
  const repository = new SqliteRunRepository(":memory:");
  let active = 0;
  let peak = 0;
  const planner = {
    async plan(): Promise<RunPlan> {
      return {
        primitives: ["sandbox"],
        reason: { sandbox: "build and independently verify" },
        verificationStrategy: "fresh execution",
      };
    },
  };
  const generator = {
    async generate() {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { stdout: "", stderr: "", events: [] };
    },
  };
  const verifier = {
    async verify() {
      return {
        score: {
          core: 45,
          reproducible: 20,
          methodology: 15,
          evidence: 15,
          budget: 5,
          total: 100,
        },
        evidence: { verified: true },
        logs: [],
      };
    },
  };
  const orchestrator = new AgentBenchOrchestrator({
    repository,
    events: new RunEventBus(),
    planner,
    generator,
    verifier,
    getTask: (id) => {
      const task = listTasks().find((candidate) => candidate.id === id);
      if (!task) throw new Error(`Unknown task: ${id}`);
      return task;
    },
    getAgent,
    createWorkspace: async (runId): Promise<DisposableWorkspace> => ({
      root: `C:\\temp\\${runId}`,
      async dispose() {},
    }),
    packageSubmission: async () => ({
      entries: { "results.json": "{}" },
      digest: "digest",
    }),
    schemaPath: "C:\\schemas\\run-plan.schema.json",
    solariApiKey: "test-key",
  });

  const records = await runMatrix(orchestrator, {
    confirm: true,
    concurrency: 1,
    agents: [...agents],
    tasks: listTasks(),
  });

  expect(records).toHaveLength(4);
  expect(records.map((run) => [run.agentId, run.taskId])).toEqual(
    expect.arrayContaining([
      ["sol-low", "url-shortener"],
      ["sol-low", "same-stats-different-graph"],
      ["luna-high", "url-shortener"],
      ["luna-high", "same-stats-different-graph"],
    ]),
  );
  expect(peak).toBe(1);
  repository.close();
});
