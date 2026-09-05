import { BenchmarkCatalog } from "@/core/benchmarks/catalog";
import { resolveBenchmarkRoots, resolveSnapshotRoot } from "@/core/benchmarks/config";
import { BenchmarkLoader } from "@/core/benchmarks/loader";
import { AuthoringService } from "@/core/authoring/service";
import type { AgentConfig } from "@/core/domain/run";
import type { TaskManifest } from "@/core/domain/task";

export type LibraryTask = {
  benchmarkId: string;
  benchmarkName: string;
  benchmarkDigest: string;
  task: TaskManifest;
  agents: AgentConfig[];
};

export async function loadTaskLibrary(writableRoot = process.env.AGENTBENCH_WRITABLE_ROOT ?? "benchmarks/local"): Promise<LibraryTask[]> {
  const snapshotsRoot = resolveSnapshotRoot(process.env.AGENTBENCH_SNAPSHOT_PATH);
  const catalog = new BenchmarkCatalog(resolveBenchmarkRoots(process.env.AGENTBENCH_BENCHMARK_ROOTS), new BenchmarkLoader(snapshotsRoot));
  const authoring = new AuthoringService({ writableRoots: [writableRoot], snapshotsRoot });
  const catalogs = [catalog];
  const builtinIds = new Set((await catalog.discover()).map(pack => pack.definition.id));
  for (const pack of await authoring.list()) {
    if (!builtinIds.has(pack.id)) catalogs.push(new BenchmarkCatalog([await authoring.getPackRoot(pack.id)], new BenchmarkLoader(snapshotsRoot)));
  }
  const items: LibraryTask[] = [];
  for (const catalog of catalogs) for (const pack of await catalog.discover()) {
    const agents = await catalog.listAgents(pack.definition.id);
    for (const task of await catalog.listTasks(pack.definition.id)) {
      items.push({ benchmarkId: pack.definition.id, benchmarkName: pack.definition.name, benchmarkDigest: pack.snapshot.digest, task, agents });
    }
  }
  return items.sort((a, b) => Number(b.task.id === "url-shortener") - Number(a.task.id === "url-shortener") || a.task.title.localeCompare(b.task.title));
}
