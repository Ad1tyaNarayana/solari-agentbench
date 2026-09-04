import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { runCli, type CliRuntime } from "@/cli";
import { resolveBenchmarkRoots } from "@/core/benchmarks/config";

test("parses benchmark roots without treating empty entries as the project root", () => {
  const projectRoot = resolve("C:\\agentbench-project");
  const roots = resolveBenchmarkRoots(
    [" packs/second ", "", "packs/first", "packs/second"].join(delimiter),
    projectRoot,
  );

  expect(roots).toEqual([
    resolve(projectRoot, "packs/second"),
    resolve(projectRoot, "packs/first"),
  ]);
});

test("passes an explicit benchmark to dry-run, run, and matrix while defaulting to the tutorial", async () => {
  const requests: unknown[] = [];
  const runtime = {
    async matrixSummary(options: unknown) {
      requests.push(["summary", options]);
      return "1 agent × 1 task = 1 run";
    },
    async runMatrix(options: unknown) {
      requests.push(["matrix", options]);
      return [];
    },
    async dryRun(request: unknown) {
      requests.push(["dry-run", request]);
      return {} as never;
    },
    async runOne(request: unknown) {
      requests.push(["run", request]);
      return {} as never;
    },
    async smoke() {
      throw new Error("not used");
    },
    writeLine() {},
    async dispose() {},
  } satisfies CliRuntime;

  await runCli(
    [
      "dry-run",
      "--benchmark",
      "custom-bench",
      "--task",
      "task-a",
      "--agent",
      "agent-a",
    ],
    runtime,
  );
  await runCli(["run", "--task", "task-a", "--agent", "agent-a"], runtime);
  await runCli(
    ["matrix", "--benchmark", "custom-bench", "--concurrency", "1", "--yes"],
    runtime,
  );

  expect(requests).toEqual([
    [
      "dry-run",
      { benchmarkId: "custom-bench", taskId: "task-a", agentId: "agent-a" },
    ],
    [
      "run",
      { benchmarkId: "agentbench-live", taskId: "task-a", agentId: "agent-a" },
    ],
    ["summary", { benchmarkId: "custom-bench", concurrency: 1 }],
    ["matrix", { benchmarkId: "custom-bench", concurrency: 1 }],
  ]);
});

test("matrix refuses to start without explicit confirmation", async () => {
  let runs = 0;
  const runtime = {
    async matrixSummary() {
      return "2 agents × 2 tasks = 4 runs";
    },
    async runMatrix() {
      runs += 1;
      return [];
    },
    async dryRun() {
      throw new Error("not used");
    },
    async runOne() {
      throw new Error("not used");
    },
    async smoke() {
      throw new Error("not used");
    },
    writeLine() {},
    async dispose() {},
  } satisfies CliRuntime;

  await expect(runCli(["matrix", "--yes=false"], runtime)).rejects.toThrow(
    /confirmation required/i,
  );
  expect(runs).toBe(0);
});

test("matrix prints its four-cell resource summary before running", async () => {
  const output: string[] = [];
  const runtime = {
    async matrixSummary() {
      return [
        "2 agents × 2 tasks = 4 runs",
        "browser · sandbox · desktop",
      ].join(" · ");
    },
    async runMatrix() {
      return [];
    },
    async dryRun() {
      throw new Error("not used");
    },
    async runOne() {
      throw new Error("not used");
    },
    async smoke() {
      throw new Error("not used");
    },
    writeLine(line: string) {
      output.push(line);
    },
    async dispose() {},
  } satisfies CliRuntime;

  await runCli(["matrix", "--concurrency", "1", "--yes"], runtime);
  expect(output.join("\n")).toMatch(/2 agents × 2 tasks = 4 runs/i);
  expect(output.join("\n")).toMatch(/browser[\s\S]*sandbox[\s\S]*desktop/i);
});

test("demo:seed exports public artifacts without initializing execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentbench-cli-demo-"));
  const runtime = {
    matrixSummary: vi.fn(async () => "not used"),
    runMatrix: vi.fn(async () => []),
    dryRun: vi.fn(async () => { throw new Error("not used"); }),
    runOne: vi.fn(async () => { throw new Error("not used"); }),
    smoke: vi.fn(async () => { throw new Error("not used"); }),
    writeLine: vi.fn(),
    dispose: vi.fn(async () => undefined),
  } satisfies CliRuntime;

  try {
    await runCli(["demo:seed", "--output", directory], runtime);
    expect(await readdir(directory)).toContain("runs.json");
    expect(runtime.runOne).not.toHaveBeenCalled();
    expect(runtime.dispose).toHaveBeenCalledOnce();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("routes live and validate-only certification without conflating their outputs", async () => {
  const output: string[] = [];
  const runtime = {
    matrixSummary: vi.fn(async () => "not used"),
    runMatrix: vi.fn(async () => []),
    dryRun: vi.fn(async () => { throw new Error("not used"); }),
    runOne: vi.fn(async () => { throw new Error("not used"); }),
    smoke: vi.fn(async () => { throw new Error("not used"); }),
    validateCertification: vi.fn(async () => ({ valid: true, provisioned: false } as never)),
    certify: vi.fn(async () => ({ solariLive: true } as never)),
    writeLine: (line: string) => output.push(line),
    dispose: vi.fn(async () => undefined),
  } satisfies CliRuntime;

  await runCli([
    "certify",
    "--benchmark-root", "examples/pack",
    "--submission", "examples/submission",
    "--validate-only",
  ], runtime);
  expect(runtime.validateCertification).toHaveBeenCalledWith({
    benchmarkRoot: resolve("examples/pack"),
    submissionDirectory: resolve("examples/submission"),
    taskId: undefined,
  });
  expect(runtime.certify).not.toHaveBeenCalled();

  await runCli([
    "certify",
    "--benchmark-root", "examples/pack",
    "--submission", "examples/submission",
    "--output", "examples/certificate.json",
    "--task", "raft-safety",
  ], runtime);
  expect(runtime.certify).toHaveBeenCalledWith({
    benchmarkRoot: resolve("examples/pack"),
    submissionDirectory: resolve("examples/submission"),
    outputPath: resolve("examples/certificate.json"),
    taskId: "raft-safety",
  });
  expect(output.join("\n")).toMatch(/provisioned[\s\S]*solariLive/i);
});

test("requires output only for live certification", async () => {
  const runtime = {
    matrixSummary: vi.fn(async () => "not used"),
    runMatrix: vi.fn(async () => []),
    dryRun: vi.fn(async () => { throw new Error("not used"); }),
    runOne: vi.fn(async () => { throw new Error("not used"); }),
    smoke: vi.fn(async () => { throw new Error("not used"); }),
    validateCertification: vi.fn(),
    certify: vi.fn(),
    writeLine: vi.fn(),
    dispose: vi.fn(async () => undefined),
  } satisfies CliRuntime;

  await expect(runCli([
    "certify",
    "--benchmark-root", "examples/pack",
    "--submission", "examples/submission",
  ], runtime)).rejects.toThrow(/--output is required/i);
  await expect(runCli([
    "certify",
    "--benchmark-root", "examples/pack",
    "--submission", "examples/submission",
    "--output", "certificate.json",
    "--validate-only",
  ], runtime)).rejects.toThrow(/--output.*validate-only/i);
});
