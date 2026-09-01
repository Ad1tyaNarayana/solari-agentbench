import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { runCli, type CliRuntime } from "@/cli";

test("matrix refuses to start without explicit confirmation", async () => {
  let runs = 0;
  const runtime = {
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
