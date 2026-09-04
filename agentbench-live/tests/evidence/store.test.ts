import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore } from "@/core/evidence/store";

test("stores redacted content by digest and deduplicates identical blobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentbench-evidence-"));
  const store = new EvidenceStore({ root, runId: "run-1", taskId: "task-1", exactSecretValues: ["secret-123"] });
  const input = { mimeType: "application/json", role: "result", producer: "evaluator" as const, value: { apiKey: "secret-123", count: 3 } };
  const first = await store.putJson(input);
  const second = await store.putJson(input);

  expect(second.digest).toBe(first.digest);
  expect(first).toMatchObject({ runId: "run-1", taskId: "task-1", role: "result", producer: "evaluator", redacted: true });
  expect((await store.get(first.digest)).toString()).not.toContain("secret-123");
  expect((await store.get(first.digest)).toString()).toContain("[REDACTED]");
  expect((await store.readManifest()).entries).toHaveLength(1);
});

test("different bytes have different digests and manifests are stable", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentbench-evidence-"));
  const store = new EvidenceStore({ root, runId: "run-2", taskId: "task-2" });
  const b = await store.putText({ mimeType: "text/plain", role: "z", producer: "orchestrator", text: "b" });
  const a = await store.putText({ mimeType: "text/plain", role: "a", producer: "agent", text: "a" });
  expect(a.digest).not.toBe(b.digest);
  const manifest = await store.readManifest();
  expect(manifest.entries.map((item) => item.digest)).toEqual([...manifest.entries.map((item) => item.digest)].sort());
  expect(JSON.parse(await readFile(join(root, "manifests", "run-2.json"), "utf8"))).toEqual(manifest);
});

test("rejects unsafe run identities", async () => {
  expect(() => new EvidenceStore({ root: "x", runId: "../escape", taskId: "task" })).toThrow(/safe/i);
});
