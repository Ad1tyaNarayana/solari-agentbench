import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { demoRuns, exportPublicDemo } from "@/core/demo/seed";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

test("public demo exporter emits permanent evidence without credential material", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentbench-demo-"));
  temporaryDirectories.push(directory);

  await exportPublicDemo(directory);
  const names = await readdir(directory);
  expect(names.sort()).toEqual([
    "runs.json",
    "same-stats-comparison.png",
    "url-shortener-browser.png",
    "url-shortener-desktop.png",
  ]);

  for (const name of names) {
    const content = await readFile(join(directory, name));
    expect(content.length, name).toBeGreaterThan(32);
    expect(content.toString("utf8"), name).not.toMatch(
      /slr_(?:live|test)_|Authorization:\s*Bearer|auth\.json|stream\.getsolari\.com\/[^\s"']+/i,
    );
  }
});

test("seeded run DTOs omit replay URLs and cover the complete matrix", () => {
  expect(demoRuns).toHaveLength(4);
  expect(demoRuns.map((run) => [run.agentId, run.taskId])).toEqual(
    expect.arrayContaining([
      ["sol-low", "url-shortener"],
      ["sol-low", "same-stats-different-graph"],
      ["luna-high", "url-shortener"],
      ["luna-high", "same-stats-different-graph"],
    ]),
  );
  expect(JSON.stringify(demoRuns)).not.toContain("browserRecording");
  expect(JSON.stringify(demoRuns)).toContain("/demo/url-shortener-desktop.png");
  expect(demoRuns.every((run) => run.provenance?.kind === "synthetic-demo")).toBe(
    true,
  );
  expect(JSON.stringify(demoRuns)).not.toMatch(/sandboxVerified/);
  expect(JSON.stringify(demoRuns)).not.toMatch(
    /verifier-owned|assertion passed|fresh verifier|hashes match/i,
  );
});
