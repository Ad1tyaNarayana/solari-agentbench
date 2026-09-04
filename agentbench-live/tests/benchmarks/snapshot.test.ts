import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBenchmarkSnapshot } from "@/core/benchmarks/snapshot";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agentbench-source-"));
  const snapshotsRoot = await mkdtemp(join(tmpdir(), "agentbench-snapshots-"));
  await mkdir(join(root, "z"));
  await writeFile(join(root, "prompt.md"), "hello");
  await writeFile(join(root, "z", "input.txt"), "input");
  return { packRoot: root, snapshotsRoot };
}

describe("createBenchmarkSnapshot", () => {
  it("creates a stable digest for identical content", async () => {
    const a = await fixture();
    const b = await fixture();
    const first = await createBenchmarkSnapshot({ ...a, semanticFiles: ["z/input.txt", "prompt.md"] });
    const second = await createBenchmarkSnapshot({ ...b, semanticFiles: ["prompt.md", "z/input.txt"] });
    expect(second.digest).toBe(first.digest);
  });

  it("changes digest when content changes", async () => {
    const f = await fixture();
    const first = await createBenchmarkSnapshot({ ...f, semanticFiles: ["prompt.md", "z/input.txt"] });
    await writeFile(join(f.packRoot, "prompt.md"), "changed");
    const second = await createBenchmarkSnapshot({ ...f, semanticFiles: ["prompt.md", "z/input.txt"] });
    expect(second.digest).not.toBe(first.digest);
  });

  it("copies immutable bytes into the snapshot", async () => {
    const f = await fixture();
    const snapshot = await createBenchmarkSnapshot({ ...f, semanticFiles: ["prompt.md", "z/input.txt"] });
    await writeFile(join(f.packRoot, "prompt.md"), "changed");
    expect(await readFile(join(snapshot.root, "prompt.md"), "utf8")).toBe("hello");
  });

  it("sorts files canonically", async () => {
    const f = await fixture();
    const snapshot = await createBenchmarkSnapshot({ ...f, semanticFiles: ["z/input.txt", "prompt.md"] });
    expect(snapshot.files.map((entry) => entry.path)).toEqual(["prompt.md", "z/input.txt"]);
  });
});
