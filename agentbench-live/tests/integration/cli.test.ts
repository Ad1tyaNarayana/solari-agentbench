import { expect, test } from "vitest";
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
