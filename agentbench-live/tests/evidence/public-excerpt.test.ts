import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import excerpt from "../../docs/review-evidence/results.json";
import raftReference from "../../docs/review-evidence/raft-reference-v1.2.0.json";
import raftAgent from "../../docs/review-evidence/raft-agent-v1.2.0.json";

it("retains the passing agent result separately on the certified Raft snapshot", () => {
  expect(raftAgent.agentId).toBe("raft-codex");
  expect(raftAgent.benchmarkDigest).toBe(raftReference.benchmark.digest);
  expect(raftAgent.quality).toBe(100);
  expect(raftAgent.timeAdjusted).toBe(39.21);
  expect(raftAgent.durationMs).toBe(765093);
  expect(raftAgent.evaluators.every(e => e.status === "passed" && e.assertions.every(a => a.passed))).toBe(true);
  expect(raftAgent.artifacts.find(e => e.role === "raft-fault-trace")?.sha256).toBe(raftReference.artifacts.find(e => e.role === "raft-fault-trace")?.sha256);
  expect(JSON.stringify(raftAgent)).not.toMatch(/https?:\/\/|X-Amz-|pt_token=/i);
});

it("identifies the live Raft reference separately from model runs and verifies its screenshot", async () => {
  expect(raftReference.agentId).toBeNull();
  expect(raftReference.quality).toBe(100);
  expect(raftReference.evaluators.every(e => e.status === "passed" && e.assertions.every(a => a.passed))).toBe(true);
  expect(raftReference.cleanupIssueCount).toBe(0);
  const bytes = await readFile(resolve("docs/review-evidence/raft-reference.png"));
  const artifact = raftReference.artifacts.find(e => e.role === "raft-fault-trace")!;
  expect(bytes.length).toBe(artifact.bytes);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
  expect(JSON.stringify(raftReference)).not.toMatch(/https?:\/\/|X-Amz-|pt_token=/i);
});

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
