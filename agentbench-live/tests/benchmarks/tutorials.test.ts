import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BenchmarkCatalog } from "@/core/benchmarks/catalog";
import { BenchmarkLoader } from "@/core/benchmarks/loader";
import { agents as legacyAgents } from "@/core/tasks/registry";
import { sameStatsSeedCsv, sameStatsTask } from "@/core/tasks/same-stats";
import { urlShortenerTask } from "@/core/tasks/url-shortener";
const pack = join(process.cwd(), "benchmarks/tutorials/agentbench-live");
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
    await expect(catalog.discover()).rejects.toThrow(/duplicate benchmark id.*agentbench-live/i);
  });
});
