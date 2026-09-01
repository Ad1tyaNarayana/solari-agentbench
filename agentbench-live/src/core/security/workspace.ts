import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type DisposableWorkspace = {
  root: string;
  dispose(): Promise<void>;
};

export async function createWorkspace(
  runId: string,
): Promise<DisposableWorkspace> {
  const temporaryRoot = await realpath(tmpdir());
  const root = await mkdtemp(join(temporaryRoot, "agentbench-"));
  await execFileAsync("git", ["init", "--quiet", root]);
  await execFileAsync("git", ["-C", root, "config", "agentbench.runId", runId]);

  return {
    root,
    async dispose() {
      let resolved: string;
      try {
        resolved = await realpath(root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (
        dirname(resolved) !== temporaryRoot ||
        !basename(resolved).startsWith("agentbench-")
      ) {
        throw new Error(`Refusing to remove unsafe workspace: ${resolved}`);
      }
      await rm(resolved, { recursive: true, force: false });
    },
  };
}
