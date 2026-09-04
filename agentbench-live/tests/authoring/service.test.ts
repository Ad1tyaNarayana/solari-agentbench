import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthoringService } from "@/core/authoring/service";
import { draft } from "./render.test";

test("creates, reloads, saves atomically, and detects external edit conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentbench-authoring-"));
  const snapshots = await mkdtemp(join(tmpdir(), "agentbench-authoring-snapshots-"));
  const service = new AuthoringService({ writableRoots: [root], snapshotsRoot: snapshots });
  const created = await service.create({ draft });
  expect(created.draft).toMatchObject({ id: "demo-bench", tasks: [{ prompt: "Build it." }] });
  const saved = await service.save({ packId: "demo-bench", expectedRevision: created.revision, draft: { ...created.draft, name: "Renamed" } });
  expect(saved.draft.name).toBe("Renamed");
  await writeFile(join(root, "demo-bench", "tasks", "task-one", "prompt.md"), "External edit.\n");
  await expect(service.save({ packId: "demo-bench", expectedRevision: saved.revision, draft: saved.draft })).rejects.toMatchObject({ code: "benchmark_conflict", changedPaths: ["tasks/task-one/prompt.md"] });
});

test("previews validation without creating a pack and rejects unsafe IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentbench-authoring-"));
  const service = new AuthoringService({ writableRoots: [root], snapshotsRoot: join(root, ".snapshots") });
  expect((await service.preview(draft)).diagnostics).toEqual([]);
  await expect(service.create({ draft: { ...draft, id: "../escape" } })).rejects.toThrow(/id/i);
});
