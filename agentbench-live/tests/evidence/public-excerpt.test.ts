import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import excerpt from "../../docs/review-evidence/results.json";

it("keeps the published comparison and unsuccessful Raft attempt explicit", () => {
  expect(excerpt.kind).toBe("reviewed-historical-live-run-excerpt");
  expect(excerpt.runs).toHaveLength(5);
  expect(new Set(excerpt.runs.slice(0, 4).map(r => r.benchmarkDigest)).size).toBe(1);
  expect(excerpt.runs.map(r => r.quality)).toEqual([73.33, 73.33, 100, 100, 10]);
  for (const run of excerpt.runs) {
    expect(run.timeAdjusted).toBe(Math.round(run.quality * Math.min(1, excerpt.targetMs / run.durationMs) * 100) / 100);
  }
  expect(excerpt.runs[4].artifacts).toEqual([]);
  expect(excerpt.runs[4].evaluators.find(e => e.id === "results")?.status).toBe("failed");
});

it("publishes unchanged screenshot bytes matching the historical manifests", async () => {
  for (const [index, name] of [[0, "url-sol.png"], [1, "url-luna.png"]] as const) {
    const bytes = await readFile(resolve("docs/review-evidence", name));
    const artifact = excerpt.runs[index].artifacts.find(e => e.role === "browser-result")!;
    expect(bytes.length).toBe(artifact.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
  }
});

it("excludes URLs, local paths and raw replay payloads from the public JSON", () => {
  const json = JSON.stringify(excerpt);
  expect(json).not.toMatch(/https?:\/\/|[A-Z]:[\\/]|pt_token=|Bearer\s|sk-[A-Za-z0-9]{16}/i);
  for (const run of excerpt.runs) for (const artifact of run.artifacts) {
    if ("replayExcerpt" in artifact && artifact.replayExcerpt) {
      expect(artifact.replayExcerpt.eventCount).toBe(21);
      expect(artifact.replayExcerpt.events).toHaveLength(21);
      for (const event of artifact.replayExcerpt.events) expect(Object.keys(event).sort()).toEqual(["elapsedMs", "type"]);
    }
  }
});
