import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("proactively forwards at most one create call for each approved primitive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentbench-mcp-guard-"));
  temporaryDirectories.push(directory);
  const upstreamPath = join(directory, "fake-upstream.mjs");
  await writeFile(
    upstreamPath,
    [
      'import { createInterface } from "node:readline";',
      "const lines = createInterface({ input: process.stdin });",
      "lines.on(\"line\", (line) => {",
      "  const request = JSON.parse(line);",
      "  process.stdout.write(`${JSON.stringify({ jsonrpc: \"2.0\", id: request.id, result: { upstream: true, tool: request.params?.name } })}\\n`);",
      "});",
    ].join("\n"),
    "utf8",
  );

  const guardPath = resolve("src/core/agents/solari-mcp-guard.mjs");
  const child = spawn(
    process.execPath,
    [
      guardPath,
      "solari_sandbox_create,solari_browser_create",
      process.execPath,
      upstreamPath,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  for (const [id, name] of [
    [1, "solari_sandbox_create"],
    [2, "solari_sandbox_create"],
    [3, "solari_browser_create"],
    [4, "solari_browser_create"],
    [5, "solari_exec"],
    [6, "solari_exec"],
    [7, "solari_desktop_create"],
  ] as const) {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: {} },
      })}\n`,
    );
  }
  child.stdin.end();

  const exitCode = await new Promise<number | null>((resolveExit) => {
    child.once("close", resolveExit);
  });
  const responses = stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .sort((left, right) => Number(left.id) - Number(right.id));

  expect(exitCode, stderr).toBe(0);
  expect(responses).toHaveLength(7);
  expect(responses[0]).toMatchObject({
    id: 1,
    result: { upstream: true, tool: "solari_sandbox_create" },
  });
  expect(responses[1]).toMatchObject({
    id: 2,
    error: { code: -32001 },
  });
  expect(responses[2]).toMatchObject({
    id: 3,
    result: { upstream: true, tool: "solari_browser_create" },
  });
  expect(responses[3]).toMatchObject({
    id: 4,
    error: { code: -32001 },
  });
  expect(responses[4]).toMatchObject({
    id: 5,
    result: { upstream: true, tool: "solari_exec" },
  });
  expect(responses[5]).toMatchObject({
    id: 6,
    result: { upstream: true, tool: "solari_exec" },
  });
  expect(responses[6]).toMatchObject({
    id: 7,
    error: { code: -32002 },
  });
});
