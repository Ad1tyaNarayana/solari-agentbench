import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BenchmarkCatalog,
  BenchmarkSelectionError,
} from "@/core/benchmarks/catalog";
import { BenchmarkLoader } from "@/core/benchmarks/loader";
import { agents as legacyAgents } from "@/core/tasks/registry";
import { sameStatsSeedCsv, sameStatsTask } from "@/core/tasks/same-stats";
import { urlShortenerTask } from "@/core/tasks/url-shortener";
const pack = join(process.cwd(), "benchmarks/tutorials/agentbench-live");

async function createPackFixture({
  benchmarkId,
  taskId,
  agentId,
}: {
  benchmarkId: string;
  taskId: string;
  agentId: string;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentbench-collision-pack-"));
  const taskRoot = join(root, "tasks", taskId);
  await mkdir(taskRoot, { recursive: true });
  await Promise.all([
    writeFile(
      join(root, "benchmark.yaml"),
      `schemaVersion: 1
id: ${benchmarkId}
name: ${benchmarkId}
version: 1.0.0
taskRoots: [tasks]
defaults:
  timeoutSeconds: 30
  maxConcurrency: 1
  submissionDirectory: submission
`,
    ),
    writeFile(
      join(root, "agents.yaml"),
      `schemaVersion: 1
agents:
  - id: ${agentId}
    name: ${agentId}
    provider: codex
    harness: { id: codex-sdk, version: local }
`,
    ),
    writeFile(
      join(taskRoot, "task.yaml"),
      `schemaVersion: 1
id: ${taskId}
name: ${taskId}
prompt: prompt.md
fixtures: []
resources:
  allowed: []
  planningRequired: true
  budget: { browserSessions: 0, sandboxes: 0, desktops: 0, totalMinutes: 1 }
submission: { directory: submission, required: [] }
evaluators:
  - { id: complete, type: command, weight: 100 }
`,
    ),
    writeFile(join(taskRoot, "prompt.md"), "Complete the task."),
  ]);
  return root;
}

describe("migrated tutorial benchmark", () => {
  it("documents the audience, trust boundary, deterministic tutorials, and Raft certification", async () => {
    const readme = await readFile(join(process.cwd(), "README.md"), "utf8");
    const repositoryReadme = await readFile(join(process.cwd(), "..", "README.md"), "utf8");
    expect(readme).toMatch(/engineering leads[\s\S]*hiring teams/i);
    expect(readme).toMatch(/sealed evaluator inputs/i);
    expect(readme).toMatch(/zero.*model-judge/i);
    expect(readme).toContain("raft-consensus-reproduction");
    expect(readme).toContain("agentbench -- certify");
    expect(readme).toMatch(/Studio[\s\S]*same[\s\S]*snapshot[\s\S]*evaluator/i);
    expect(repositoryReadme).toContain("raft-consensus-reproduction");
  });

  it("keeps both bundled tutorials deterministic with zero model-judge points", async () => {
    const catalog = new BenchmarkCatalog([pack], new BenchmarkLoader(await mkdtemp(join(tmpdir(), "agentbench-tutorial-snapshots-"))));
    const loaded = await catalog.getBenchmark("agentbench-live");
    for (const task of loaded.definition.tasks) {
      expect(task.evaluators.filter((evaluator) => evaluator.type === "model-judge")).toHaveLength(0);
    }
  });

  it("projects canonical files to generic evaluator task and agent contracts", async () => {
    const catalog = new BenchmarkCatalog([pack], new BenchmarkLoader(await mkdtemp(join(tmpdir(), "agentbench-tutorial-snapshots-"))));
    const loaded = await catalog.getBenchmark("agentbench-live");
    expect(loaded.definition.version).toBe("1.0.0");
    expect(loaded.definition.tasks.map(({ id }) => id)).toEqual(["same-stats-different-graph", "url-shortener"]);
    for (const tutorial of [urlShortenerTask, sameStatsTask]) {
      const task = await catalog.getTask(tutorial.id);
      expect(task).toMatchObject({ id: tutorial.id, version: tutorial.version, title: tutorial.title, prompt: tutorial.prompt, allowedPrimitives: tutorial.allowedPrimitives });
      expect(task.verifier).toBeUndefined();
      expect(task.evaluators?.reduce((sum, evaluator) => sum + (evaluator.enabled ? evaluator.weight : 0), 0)).toBe(100);
    }
    const urlPrompt = await readFile(join(pack, "tasks/url-shortener/prompt.md"), "utf8");
    const statsPrompt = await readFile(join(pack, "tasks/same-stats-different-graph/prompt.md"), "utf8");
    expect(urlPrompt).toBe(urlShortenerTask.prompt);
    expect(statsPrompt).toBe(sameStatsTask.prompt);
    expect(urlPrompt.endsWith("\n")).toBe(false);
    expect(statsPrompt.endsWith("\n")).toBe(false);
    expect(await catalog.listAgents()).toEqual(legacyAgents.map((agent) => ({ ...agent })).sort((a, b) => a.id.localeCompare(b.id)));
    const seed = await readFile(join(pack, "tasks/same-stats-different-graph/fixtures/seed.csv"), "utf8");
    expect(seed.replace(/\r\n/g, "\n").replace(/\n?$/, "\n")).toBe(sameStatsSeedCsv);
  });
  it("rejects benchmark collisions across configured roots", async () => {
    const catalog = new BenchmarkCatalog([pack, pack], new BenchmarkLoader(await mkdtemp(join(tmpdir(), "agentbench-tutorial-snapshots-"))));
    let failure: unknown;
    try {
      await catalog.discover();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "benchmark_invalid" });
    expect((failure as Error).message).toMatch(/duplicate benchmark id.*agentbench-live/i);
    expect((failure as Error).message).not.toContain(pack);
  });

  it("rejects task ID collisions across differently identified benchmarks", async () => {
    const first = await createPackFixture({
      benchmarkId: "benchmark-alpha",
      taskId: "shared-task",
      agentId: "agent-alpha",
    });
    const second = await createPackFixture({
      benchmarkId: "benchmark-beta",
      taskId: "shared-task",
      agentId: "agent-beta",
    });
    const catalog = new BenchmarkCatalog(
      [first, second],
      new BenchmarkLoader(
        await mkdtemp(join(tmpdir(), "agentbench-collision-snapshots-")),
      ),
    );

    await expect(catalog.discover()).rejects.toMatchObject({
      code: "benchmark_invalid",
      message:
        "Duplicate task id shared-task in benchmarks benchmark-alpha and benchmark-beta",
    });
  });

  it("rejects agent ID collisions across differently identified benchmarks", async () => {
    const first = await createPackFixture({
      benchmarkId: "benchmark-alpha",
      taskId: "task-alpha",
      agentId: "shared-agent",
    });
    const second = await createPackFixture({
      benchmarkId: "benchmark-beta",
      taskId: "task-beta",
      agentId: "shared-agent",
    });
    const catalog = new BenchmarkCatalog(
      [first, second],
      new BenchmarkLoader(
        await mkdtemp(join(tmpdir(), "agentbench-collision-snapshots-")),
      ),
    );

    await expect(catalog.discover()).rejects.toMatchObject({
      code: "benchmark_invalid",
      message:
        "Duplicate agent id shared-agent in benchmarks benchmark-alpha and benchmark-beta",
    });
  });

  it.each([
    ["missing-benchmark", "url-shortener", "sol-low", "unknown_benchmark"],
    ["agentbench-live", "missing-task", "sol-low", "unknown_task"],
    ["agentbench-live", "url-shortener", "missing-agent", "unknown_agent"],
  ] as const)(
    "returns a typed selection error for %s / %s / %s",
    async (benchmarkId, taskId, agentId, code) => {
      const catalog = new BenchmarkCatalog(
        [pack],
        new BenchmarkLoader(
          await mkdtemp(join(tmpdir(), "agentbench-tutorial-snapshots-")),
        ),
      );

      await expect(
        catalog.resolveSelection({ benchmarkId, taskId, agentId }),
      ).rejects.toMatchObject({ code });
    },
  );

  it("does not expose an invalid benchmark root in selection errors", async () => {
    const invalidRoot = await mkdtemp(join(tmpdir(), "agentbench-invalid-pack-"));
    const catalog = new BenchmarkCatalog(
      [invalidRoot],
      new BenchmarkLoader(
        await mkdtemp(join(tmpdir(), "agentbench-tutorial-snapshots-")),
      ),
    );

    let failure: unknown;
    try {
      await catalog.resolveSelection({
        benchmarkId: "broken",
        taskId: "task",
        agentId: "agent",
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(BenchmarkSelectionError);
    expect(failure).toMatchObject({ code: "benchmark_invalid" });
    expect((failure as Error).message).not.toContain(invalidRoot);
  });
});
