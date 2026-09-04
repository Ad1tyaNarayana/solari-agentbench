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
  it("projects canonical files to the legacy task and agent contracts", async () => {
    const catalog = new BenchmarkCatalog([pack], new BenchmarkLoader(await mkdtemp(join(tmpdir(), "agentbench-tutorial-snapshots-"))));
    const loaded = await catalog.getBenchmark("agentbench-live");
    expect(loaded.definition.version).toBe("1.0.0");
    expect(loaded.definition.tasks.map(({ id }) => id)).toEqual(["same-stats-different-graph", "url-shortener"]);
    for (const legacy of [urlShortenerTask, sameStatsTask]) {
      const task = await catalog.getTask(legacy.id);
      expect(task).toMatchObject({ id: legacy.id, version: legacy.version, title: legacy.title, prompt: legacy.prompt, allowedPrimitives: legacy.allowedPrimitives, requiredEvidence: legacy.requiredEvidence, budget: legacy.budget, verifier: legacy.verifier });
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
