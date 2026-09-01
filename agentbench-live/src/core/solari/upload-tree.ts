import { posix } from "node:path";
import type { SubmissionPackage } from "@/core/security/package-submission";
import type { SandboxHandle } from "./contracts";

const submissionRoot = "/work/submission";

function assertDestination(destination: string): string {
  const normalized = posix.normalize(destination);
  if (
    normalized !== submissionRoot &&
    !normalized.startsWith(`${submissionRoot}/`)
  ) {
    throw new Error(`Upload destination is outside ${submissionRoot}: ${destination}`);
  }
  return normalized;
}

export async function uploadTextTree(
  sandbox: Pick<SandboxHandle, "mkdir" | "writeFile">,
  submission: SubmissionPackage,
  destination = submissionRoot,
): Promise<void> {
  const root = assertDestination(destination);
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
    const target = assertDestination(posix.join(root, relativePath));
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
    await sandbox.writeFile(
      posix.join(root, relativePath),
      submission.entries[relativePath],
    );
  }
}
