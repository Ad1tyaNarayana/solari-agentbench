import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvidenceStore } from "@/core/evidence/store";
import { readRunArtifact } from "@/server/read-artifact";

test("serves only run-owned, unmodified evidence and rejects traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-read-"));
  const store = new EvidenceStore({ root, runId: "run1", taskId: "task1" });
  const ref = await store.putText({ text: "verified", role: "stdout", mimeType: "text/plain", producer: "evaluator" });
  const manifest = await store.readManifest();
  expect((await readRunArtifact(root, "run1", "task1", ref.digest, manifest))?.bytes.toString()).toBe("verified");
  expect(await readRunArtifact(root, "run2", "task1", ref.digest, manifest)).toBeUndefined();
  expect(await readRunArtifact(root, "run1", "task1", "../secret", manifest)).toBeUndefined();
  await writeFile(join(root, "sha256", ref.digest.slice(0, 2), ref.digest), "tampered");
  expect(await readRunArtifact(root, "run1", "task1", ref.digest, manifest)).toBeUndefined();
});
