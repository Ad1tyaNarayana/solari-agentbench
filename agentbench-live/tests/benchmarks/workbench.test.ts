import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BenchmarkLoader } from "@/core/benchmarks/loader";
import { BenchmarkCatalog } from "@/core/benchmarks/catalog";
import { resolveBenchmarkRoots } from "@/core/benchmarks/config";
import { loadTaskLibrary } from "@/server/task-library";
import { AuthoringService } from "@/core/authoring/service";
import { initialDraft } from "@/components/studio/use-benchmark-draft";

test("saved Studio packs appear in the task library with their own agent selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbench-custom-"));
  const authoring = new AuthoringService({ writableRoots: [root], snapshotsRoot: join(root, ".snapshots") });
  await authoring.create({ draft: { ...initialDraft, id: "custom-research", name: "Custom Research" } });
  const items = await loadTaskLibrary(root);
  expect(items.find(item => item.benchmarkId === "custom-research")).toMatchObject({ task: { id: "first-task" }, agents: [{ id: "codex" }] });
});

test("tutorial snapshots carry executable verifier bytes referenced by argv", async () => {
  const pack = join(process.cwd(), "benchmarks/tutorials/agentbench-live");
  const loaded = await new BenchmarkLoader(await mkdtemp(join(tmpdir(), "workbench-"))).load(pack);
  for (const path of ["tasks/url-shortener/evaluators/verify-app.mjs", "tasks/same-stats-different-graph/evaluators/reproduce.py"]) {
    expect(loaded.snapshot.files.some(file => file.path === path)).toBe(true);
    expect(await readFile(join(loaded.snapshot.root, path), "utf8")).toBe(await readFile(join(pack, path), "utf8"));
  }
});

test("default catalog makes the Raft research task selectable", async () => {
  const catalog = new BenchmarkCatalog(resolveBenchmarkRoots(undefined), new BenchmarkLoader(await mkdtemp(join(tmpdir(), "workbench-"))));
  const packs = await catalog.discover();
  expect(packs.flatMap(pack => pack.definition.tasks)).toHaveLength(3);
  const raft = packs.find(pack => pack.definition.id === "raft-consensus-reproduction");
  expect(raft).toBeDefined();
});
