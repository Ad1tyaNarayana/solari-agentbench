import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandEvaluator } from "@/core/evaluators/command";
import type { EvaluatorContext } from "@/core/evaluators/types";

function fakeSandbox(exitCode = 0) {
  return {
    id: "sandbox-1", mkdir: vi.fn(async (path: string) => { void path; }), writeFile: vi.fn(async (path: string, contents: string | Uint8Array) => { void path; void contents; }),
    readFile: vi.fn(async (): Promise<Uint8Array> => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }),
    exec: vi.fn(async () => ({ exitCode, stdout: "hello", stderr: "" })), start: vi.fn(), previewUrl: vi.fn(), kill: vi.fn(async () => undefined),
  };
}

async function context(sandbox: ReturnType<typeof fakeSandbox>): Promise<EvaluatorContext> {
  const root = await mkdtemp(join(tmpdir(), "agentbench-command-"));
  await writeFile(join(root, "prompt.md"), "prompt");
  return {
    runId: "r", taskId: "t", submission: { digest: "x", entries: { "app.js": { kind: "text", contents: "ok" } } },
    snapshot: { root, digest: "s", files: [{ path: "prompt.md", digest: "d", size: 6 }] },
    resources: { acquireSandbox: vi.fn(async () => sandbox) },
    evidence: { putText: vi.fn(async (input) => ({ ...input, digest: "a".repeat(64), size: 1, runId: "r", taskId: "t", createdAt: "now", redacted: true })) },
    remainingMs: () => 5_000,
  } as unknown as EvaluatorContext;
}

test("uses a fresh sandbox, uploads immutable inputs, and denies network with unshare", async () => {
  const sandbox = fakeSandbox();
  const outcome = await new CommandEvaluator().evaluate({ id: "cmd", type: "command", weight: 100, enabled: true, prerequisites: [], config: { argv: ["node", "/submission/app.js"] } }, await context(sandbox), new AbortController().signal);
  expect(sandbox.exec).toHaveBeenNthCalledWith(1, "unshare", ["--user", "--map-root-user", "--net", "--", "true"], expect.anything());
  expect(sandbox.exec).toHaveBeenNthCalledWith(2, "unshare", ["--user", "--map-root-user", "--net", "--mount-proc", "--", "node", "/submission/app.js"], expect.objectContaining({ env: { AGENTBENCH_RESULT: "/result/evaluator-result.json" } }));
  expect(outcome.status).toBe("passed");
  expect(sandbox.writeFile).toHaveBeenCalledWith("/submission/app.js", "ok");
  expect(sandbox.writeFile.mock.calls.find(([path]) => path === "/benchmark/prompt.md")?.[1]).toBeDefined();
});

test("maps command exits to failed assertions and network infrastructure failures to errors", async () => {
  const sandbox = fakeSandbox(2);
  expect((await new CommandEvaluator().evaluate({ id: "cmd", type: "command", weight: 100, enabled: true, prerequisites: [], config: { argv: ["false"], network: true } }, await context(sandbox), new AbortController().signal)).status).toBe("failed");
  const unsupported = fakeSandbox(); unsupported.exec.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "denied" });
  await expect(new CommandEvaluator().evaluate({ id: "cmd", type: "command", weight: 100, enabled: true, prerequisites: [], config: { argv: ["true"] } }, await context(unsupported), new AbortController().signal)).rejects.toThrow(/network isolation/i);
});

test("treats a malformed declared result file as an evaluator error", async () => {
  const sandbox = fakeSandbox(); sandbox.readFile.mockResolvedValue(new TextEncoder().encode("not json"));
  await expect(new CommandEvaluator().evaluate({ id: "cmd", type: "command", weight: 100, enabled: true, prerequisites: [], config: { argv: ["true"], network: true } }, await context(sandbox), new AbortController().signal)).rejects.toThrow(/json/i);
});
