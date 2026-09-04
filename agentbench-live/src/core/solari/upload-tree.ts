import { posix } from "node:path";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BenchmarkSnapshot } from "@/core/benchmarks/snapshot";
import type { SubmissionPackage } from "@/core/security/package-submission";
import type { SandboxHandle } from "./contracts";

const submissionRoot = "/work/submission";

function assertDestination(destination: string, allowedRoot = submissionRoot): string {
  const normalized = posix.normalize(destination);
  if (
    normalized !== allowedRoot &&
    !normalized.startsWith(`${allowedRoot}/`)
  ) {
    throw new Error(`Upload destination is outside ${allowedRoot}: ${destination}`);
  }
  return normalized;
}

export async function uploadSnapshotTree(
  sandbox: Pick<SandboxHandle, "mkdir" | "writeFile">,
  snapshot: BenchmarkSnapshot,
  destination = "/benchmark",
): Promise<void> {
  await sandbox.mkdir(destination);
  const directories = new Set<string>();
  for (const file of snapshot.files) {
    let parent = posix.dirname(posix.join(destination, file.path));
    while (parent.startsWith(destination) && parent !== destination) { directories.add(parent); parent = posix.dirname(parent); }
  }
  for (const directory of [...directories].sort((a, b) => a.length - b.length || a.localeCompare(b))) await sandbox.mkdir(directory);
  for (const file of snapshot.files) await sandbox.writeFile(posix.join(destination, file.path), await readFile(join(snapshot.root, ...file.path.split("/"))));
}

export async function uploadTextTree(
  sandbox: Pick<SandboxHandle, "mkdir" | "writeFile">,
  submission: SubmissionPackage,
  destination = submissionRoot,
): Promise<void> {
  const requestedRoot = posix.normalize(destination);
  if (requestedRoot !== submissionRoot && requestedRoot !== "/submission") throw new Error(`Upload destination is outside ${submissionRoot}: ${destination}`);
  const root = assertDestination(destination, requestedRoot);
  const files = Object.keys(submission.entries).sort();
  const directories = new Set([root]);

  for (const relativePath of files) {
    if (
      posix.isAbsolute(relativePath) ||
      relativePath === ".." ||
      relativePath.startsWith("../")
    ) {
      throw new Error(`Unsafe submission path: ${relativePath}`);
    }
    const target = assertDestination(posix.join(root, relativePath), root);
    let parent = posix.dirname(target);
    while (parent !== posix.dirname(root) && parent.startsWith(root)) {
      directories.add(parent);
      if (parent === root) break;
      parent = posix.dirname(parent);
    }
  }

  for (const directory of [...directories].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth || left.localeCompare(right);
  })) {
    await sandbox.mkdir(directory);
  }
  for (const relativePath of files) {
    const entry = submission.entries[relativePath];
    await sandbox.writeFile(
      posix.join(root, relativePath),
      entry.contents,
    );
  }
}
