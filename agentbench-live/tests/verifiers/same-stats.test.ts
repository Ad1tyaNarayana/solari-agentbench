import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { expect, test } from "vitest";
import type { RunPlan } from "@/core/domain/plan";
import type { AgentConfig, RunRecord } from "@/core/domain/run";
import type { SubmissionPackage } from "@/core/security/package-submission";
import type {
  SandboxHandle,
  SandboxProcess,
  SandboxService,
} from "@/core/solari/contracts";
import { sameStatsTask } from "@/core/tasks/same-stats";
import {
  circleError,
  summaryStats,
  withinStatsTolerance,
} from "@/core/verifiers/geometry";
import { SameStatsVerifier } from "@/core/verifiers/same-stats";

const expected = {
  meanX: 54.27,
  meanY: 47.84,
  varianceX: 280.9,
  varianceY: 725.23,
  correlation: -0.07,
};

const circlePoints = parsePoints(readFileSync(resolve("tests/fixtures/same-stats/seed.csv"), "utf8"));
const linePoints = Array.from({ length: 8 }, () => ({ x: 54.27, y: 47.84 }));
const targetCircle = { centerX: 54.27, centerY: 47.84, radiusX: 16.76, radiusY: 26.93 };

test("accepts summary statistics inside tolerance and rejects outside it", () => {
  expect(
    withinStatsTolerance({ ...expected, meanX: 54.31 }, expected, 0.05),
  ).toBe(true);
  expect(
    withinStatsTolerance({ ...expected, meanX: 54.33 }, expected, 0.05),
  ).toBe(false);
});

test("computes sample statistics for the task-owned fixture", () => {
  expect(summaryStats(circlePoints)).toMatchObject({
    meanX: expect.closeTo(expected.meanX, 6),
    meanY: expect.closeTo(expected.meanY, 6),
    varianceX: expect.closeTo(expected.varianceX, 4),
    varianceY: expect.closeTo(expected.varianceY, 4),
    correlation: expect.closeTo(expected.correlation, 6),
  });
});

test("circle error is lower for points near the target circumference", () => {
  expect(circleError(circlePoints, targetCircle)).toBeLessThan(
    circleError(linePoints, targetCircle),
  );
});

test("independently accepts deterministic statistics, shape, and PNG evidence", async () => {
  const services = createSameStatsServices();
  const context = verifierContext(fixturePackage());
  context.onStage = (
    stage: "provisioning" | "building" | "verifying" | "capturing",
  ) => {
    services.state.stages.push(stage);
  };
  const result = await new SameStatsVerifier(services).verify(
    context,
  );
  expect(result.findings).toMatchObject({
    statisticsPassed: true,
    shapePassed: true,
    reproducible: true,
  });
  expect(result.score.total).toBe(100);
  expect(result.evidence.comparisonPlot).toMatch(/^data:image\/png;base64,/);
  expect(services.state.sandboxKilled).toBe(true);
  expect(services.state.sandboxKillCalls).toBe(1);
  expect(services.state.stages).toEqual([
    "provisioning",
    "building",
    "verifying",
    "capturing",
  ]);
});

test("a byte-different rerun fails the reproducibility prerequisite", async () => {
  const services = createSameStatsServices({ nondeterministic: true });
  const result = await new SameStatsVerifier(services).verify(
    verifierContext(fixturePackage()),
  );
  expect(result.findings.reproducible).toBe(false);
  expect(result.score.total).toBe(0);
});

function parsePoints(csv: string) {
  return csv
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => {
      const [x, y] = line.split(",").map(Number);
      return { x, y };
    });
}

function fixturePackage(): SubmissionPackage {
  const root = resolve("tests/fixtures/same-stats/passing/submission");
  const entries: SubmissionPackage["entries"] = {};
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = resolve(directory, name);
      if (statSync(path).isDirectory()) visit(path);
      else {
        entries[relative(root, path).replaceAll("\\", "/")] = {
          kind: "text",
          contents: readFileSync(path, "utf8"),
        };
      }
    }
  };
  visit(root);
  return { entries, digest: "fixture-digest" };
}

function verifierContext(submission: SubmissionPackage) {
  const run: RunRecord = {
    id: "run-stats",
    taskId: sameStatsTask.id,
    taskVersion: sameStatsTask.version,
    agentId: "luna-high",
    stage: "verifying",
    sanitizedLogs: [],
    createdAt: "2026-09-01T00:00:00.000Z",
  };
  const agent: AgentConfig = {
    id: "luna-high",
    label: "Luna · High",
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
  };
  const plan: RunPlan = {
    primitives: ["sandbox"],
    reason: { sandbox: "reproduce findings" },
    verificationStrategy: "recompute metrics",
  };
  return {
    run,
    task: sameStatsTask,
    agent,
    plan,
    submission,
    remainingMs: () => 1_234,
    runWithDeadline: async <T>(_label: string, operation: () => Promise<T>) =>
      operation(),
    onStage: (
      stage: "provisioning" | "building" | "verifying" | "capturing",
    ): void => {
      void stage;
    },
  };
}

function createSameStatsServices(options: { nondeterministic?: boolean } = {}): {
  sandbox: SandboxService;
  state: {
    sandboxKilled: boolean;
    sandboxKillCalls: number;
    stages: string[];
  };
} {
  const state = { sandboxKilled: false, sandboxKillCalls: 0, stages: [] as string[] };
  const points = readFileSync(resolve("tests/fixtures/same-stats/seed.csv"));
  const files = new Map<string, Uint8Array>([
    ["/work/output-1/points.csv", points],
    [
      "/work/output-2/points.csv",
      options.nondeterministic
        ? Buffer.from(`${points.toString("utf8")}55,55\n`)
        : points,
    ],
    ["/work/output-1/results.json", Buffer.from('{"seed":1729}')],
    [
      "/work/output-1/comparison.png",
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]),
    ],
  ]);
  const processHandle: SandboxProcess = {
    async wait() {
      return 0;
    },
    async kill() {},
  };
  const handle: SandboxHandle = {
    id: "sandbox-stats",
    async exec() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async start() {
      return processHandle;
    },
    async mkdir() {},
    async writeFile(path, contents) {
      files.set(path, Buffer.from(contents));
    },
    async readFile(path) {
      const value = files.get(path);
      if (!value) throw new Error(`Missing fake file: ${path}`);
      return value;
    },
    async previewUrl() {
      return { url: "" };
    },
    async kill() {
      state.sandboxKilled = true;
      state.sandboxKillCalls += 1;
    },
  };
  const sandbox: SandboxService = {
    async create() {
      return handle;
    },
    async connect() {
      return handle;
    },
    async listIds() {
      return [];
    },
    async kill() {
      state.sandboxKilled = true;
    },
  };
  return { sandbox, state };
}
