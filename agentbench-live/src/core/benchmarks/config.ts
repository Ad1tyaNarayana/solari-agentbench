import { delimiter, resolve } from "node:path";

const DEFAULT_BENCHMARK_ROOT = "benchmarks/tutorials/agentbench-live";
const DEFAULT_SNAPSHOT_ROOT = ".agentbench/snapshots";

export function resolveBenchmarkRoots(
  configuredRoots: string | undefined,
  projectRoot: string = process.cwd(),
): string[] {
  const entries = configuredRoots
    ?.split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const roots = entries?.length ? entries : [DEFAULT_BENCHMARK_ROOT];
  const seen = new Set<string>();

  return roots.flatMap((entry) => {
    const absolute = resolve(projectRoot, entry);
    const identity = process.platform === "win32" ? absolute.toLowerCase() : absolute;
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [absolute];
  });
}

export function resolveSnapshotRoot(
  configuredPath: string | undefined,
  projectRoot: string = process.cwd(),
): string {
  const path = configuredPath?.trim() || DEFAULT_SNAPSHOT_ROOT;
  return resolve(projectRoot, path);
}
