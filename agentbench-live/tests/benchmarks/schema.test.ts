import { describe, expect, it } from "vitest";
import { AgentsFileSchema, BenchmarkFileSchema, TaskFileSchema, parseBenchmarkFile, parseTaskFile } from "@/core/benchmarks/schema";
import { BenchmarkValidationError } from "@/core/benchmarks/types";

const valid = {
  schemaVersion: 1,
  id: "reproduce-result",
  name: "Reproduce result",
  prompt: "prompt.md",
  fixtures: ["fixtures/input.csv"],
  resources: {
    allowed: ["browser", "sandbox", "desktop"],
    planningRequired: true,
    budget: { browserSessions: 1, sandboxes: 1, desktops: 1, totalMinutes: 10 },
  },
  submission: { directory: "submission", required: ["results.json"] },
  compatibility: {
    requiredEvidence: ["sandbox"],
    legacyVerifier: "same-stats-different-graph",
    legacyBudgetMs: { totalMs: 300000, browserMs: 60000, sandboxMs: 180000, desktopMs: 0 },
  },
  evaluators: [{ id: "shape", type: "schema", weight: 100, config: {} }],
};

describe("parseTaskFile", () => {
  it("exports the canonical strict schemas", () => {
    expect(TaskFileSchema).toBeDefined();
    expect(AgentsFileSchema).toBeDefined();
    expect(BenchmarkFileSchema).toBeDefined();
  });
  it("accepts a strict version-one task", () => expect(parseTaskFile(valid).id).toBe("reproduce-result"));
  it("rejects unknown keys", () => expect(() => parseTaskFile({ ...valid, typo: true })).toThrow(/Unrecognized key.*typo/i));
  it("rejects duplicate evaluator IDs", () => expect(() => parseTaskFile({ ...valid, evaluators: [{ ...valid.evaluators[0] }, { ...valid.evaluators[0] }] })).toThrow(/duplicate.*id/i));
  it("rejects negative budget", () => expect(() => parseTaskFile({ ...valid, resources: { ...valid.resources, budget: { ...valid.resources.budget, totalMinutes: -1 } } })).toThrow(/greater than or equal to 0|positive|>=0/i));
  it("rejects missing prompt path", () => expect(() => parseTaskFile({ ...valid, prompt: "" })).toThrow(/prompt/i));
  it("requires enabled weights to total 100", () => expect(() => parseTaskFile({ ...valid, evaluators: [{ ...valid.evaluators[0], weight: 90 }] })).toThrow(/weights.*100/i));
  it.each(["/tmp/prompt.md", "C:\\tmp\\prompt.md", "../../outside.md"])("rejects unsafe prompt path %s", (prompt) => expect(() => parseTaskFile({ ...valid, prompt })).toThrow(/relative|path|traversal/i));
  it("rejects unsafe fixture and submission paths", () => {
    expect(() => parseTaskFile({ ...valid, fixtures: ["/tmp/input.csv"] })).toThrow(/relative|path/i);
    expect(() => parseTaskFile({ ...valid, submission: { ...valid.submission, directory: "../../out" } })).toThrow(/relative|path/i);
  });
  it("converts malformed YAML to BenchmarkValidationError", () => {
    try { parseTaskFile("schemaVersion: ["); } catch (error) { expect(error).toBeInstanceOf(BenchmarkValidationError); return; }
    throw new Error("expected validation error");
  });
});

describe("parseBenchmarkFile", () => {
  it("parses the canonical taskRoots manifest", () => {
    const manifest = parseBenchmarkFile({ schemaVersion: 1, id: "bench", name: "Bench", version: "1.0.0", taskRoots: ["tasks"], defaults: { timeoutSeconds: 30, maxConcurrency: 1, submissionDirectory: "submission" } });
    expect(manifest.taskRoots).toEqual(["tasks"]);
    expect(manifest).not.toHaveProperty("tasks");
  });
  it.each(["/tmp/tasks", "C:\\tasks", "../../tasks"])("rejects unsafe task root %s", (taskRoots) => expect(() => parseBenchmarkFile({ schemaVersion: 1, id: "bench", name: "Bench", version: "1.0.0", taskRoots: [taskRoots], defaults: { timeoutSeconds: 30, maxConcurrency: 1, submissionDirectory: "submission" } })).toThrow(/relative|path|traversal/i));
});
