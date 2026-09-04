import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const actualFs = await vi.importActual<typeof import("node:fs/promises")>(
  "node:fs/promises",
);

afterEach(() => {
  vi.doUnmock("@/core/benchmarks/snapshot");
  vi.resetModules();
});

describe("BenchmarkLoader revision attribution", () => {
  it("builds the task definition and snapshot from the same prompt bytes", async () => {
    const root = await actualFs.mkdtemp(join(tmpdir(), "agentbench-pack-"));
    const snapshots = await actualFs.mkdtemp(
      join(tmpdir(), "agentbench-snapshots-"),
    );
    const promptPath = join(root, "tasks", "task", "prompt.md");
    await actualFs.mkdir(join(root, "tasks", "task", "fixtures"), {
      recursive: true,
    });
    await actualFs.writeFile(
      join(root, "benchmark.yaml"),
      `schemaVersion: 1
id: demo
name: Demo
version: 1.0.0
taskRoots: [tasks]
defaults:
  timeoutSeconds: 30
  maxConcurrency: 1
  submissionDirectory: submission
`,
    );
    await actualFs.writeFile(
      join(root, "agents.yaml"),
      `schemaVersion: 1
agents:
  - schemaVersion: 1
    id: agent
    name: Agent
    provider: test
    harness: { id: test, version: '1' }
`,
    );
    await actualFs.writeFile(
      join(root, "tasks", "task", "task.yaml"),
      `schemaVersion: 1
id: task
name: Task
prompt: prompt.md
fixtures: [fixtures/input.txt]
resources:
  allowed: [sandbox]
  planningRequired: false
  budget: { browserSessions: 0, sandboxes: 1, desktops: 0, totalMinutes: 1 }
submission: { directory: submission, required: [result.txt] }
evaluators:
  - id: files
    type: file
    weight: 100
    config: { subject: result.txt }
`,
    );
    await actualFs.writeFile(promptPath, "Prompt from revision A");
    await actualFs.writeFile(
      join(root, "tasks", "task", "fixtures", "input.txt"),
      "fixture",
    );

    const actualSnapshot = await vi.importActual<
      typeof import("@/core/benchmarks/snapshot")
    >("@/core/benchmarks/snapshot");
    let snapshotCreations = 0;
    vi.doMock("@/core/benchmarks/snapshot", () => ({
      ...actualSnapshot,
      createBenchmarkSnapshot: async (
        input: Parameters<typeof actualSnapshot.createBenchmarkSnapshot>[0],
      ) => {
        snapshotCreations += 1;
        await actualFs.writeFile(promptPath, "Prompt from revision B");
        return actualSnapshot.createBenchmarkSnapshot(input);
      },
    }));
    const { BenchmarkLoader } = await import("@/core/benchmarks/loader");

    const loaded = await new BenchmarkLoader(snapshots).load(root);
    const snapshottedPrompt = await actualFs.readFile(
      join(loaded.snapshot.root, "tasks", "task", "prompt.md"),
      "utf8",
    );
    const promptEntry = loaded.snapshot.files.find(
      (entry) => entry.path === "tasks/task/prompt.md",
    );

    expect(snapshotCreations).toBe(1);
    expect(await actualFs.readFile(promptPath, "utf8")).toBe(
      "Prompt from revision B",
    );
    expect(loaded.definition.tasks[0]?.prompt).toBe("Prompt from revision A");
    expect(snapshottedPrompt).toBe("Prompt from revision A");
    expect(promptEntry).toEqual({
      path: "tasks/task/prompt.md",
      digest: createHash("sha256")
        .update("Prompt from revision A")
        .digest("hex"),
      size: Buffer.byteLength("Prompt from revision A"),
    });
    expect(loaded.snapshot.root.endsWith(loaded.snapshot.digest)).toBe(true);
  });
});
