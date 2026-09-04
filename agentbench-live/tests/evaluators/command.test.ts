import { mkdtemp, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandEvaluator } from "@/core/evaluators/command";
import type { EvaluatorContext } from "@/core/evaluators/types";

function fakeSandbox(exitCode = 0) {
  const files = new Map<string, Uint8Array>();
  return {
    id: "sandbox-1",
    files,
    mkdir: vi.fn(async (path: string) => { void path; }),
    writeFile: vi.fn(async (path: string, contents: string | Uint8Array) => {
      files.set(path, typeof contents === "string" ? new TextEncoder().encode(contents) : contents);
    }),
    readFile: vi.fn(async (path: string): Promise<Uint8Array> => {
      const contents = files.get(path);
      if (contents) return contents;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }),
    exec: vi.fn(async (command: string, args: string[] = []) => {
      if (command === "find") {
        return { exitCode: 0, stdout: `${[...files.keys()].filter((path) => path.startsWith("/benchmark/") || path.startsWith("/submission/")).join("\0")}\0`, stderr: "" };
      }
      if (command === "chmod" || (command === "unshare" && !args.includes("--mount-proc"))) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode, stdout: "hello", stderr: "" };
    }),
    start: vi.fn(), previewUrl: vi.fn(), kill: vi.fn(async () => undefined),
  };
}

async function context(sandbox: ReturnType<typeof fakeSandbox>): Promise<EvaluatorContext> {
  const root = await mkdtemp(join(tmpdir(), "agentbench-command-"));
  await writeFile(join(root, "prompt.md"), "prompt");
  return {
    runId: "r", taskId: "t", submission: { digest: "x", entries: { "app.js": { kind: "text", contents: "ok" } } },
    snapshot: { root, digest: "s", files: [{ path: "prompt.md", digest: createHash("sha256").update("prompt").digest("hex"), size: 6 }] },
    resources: { acquireSandbox: vi.fn(async () => sandbox), registerFinalizer: vi.fn() },
    evidence: {
      putText: vi.fn(async (input) => ({ ...input, digest: "a".repeat(64), size: 1, runId: "r", taskId: "t", createdAt: "now", redacted: true })),
      putJson: vi.fn(async (input) => ({ ...input, digest: "b".repeat(64), size: 1, runId: "r", taskId: "t", createdAt: "now", redacted: true })),
    },
    remainingMs: () => 5_000,
  } as unknown as EvaluatorContext;
}

test("uses a fresh sandbox, uploads immutable inputs, and denies network with unshare", async () => {
  const sandbox = fakeSandbox();
  const evaluatorContext = await context(sandbox);
  const outcome = await new CommandEvaluator().evaluate({ id: "cmd", type: "command", weight: 100, enabled: true, prerequisites: [], config: { argv: ["node", "/submission/app.js"] } }, evaluatorContext, new AbortController().signal);
  expect(sandbox.exec).toHaveBeenNthCalledWith(1, "chmod", ["-R", "a-w", "/benchmark", "/submission"], expect.anything());
  expect(sandbox.exec).toHaveBeenNthCalledWith(2, "unshare", ["--user", "--map-root-user", "--net", "--", "true"], expect.anything());
  expect(sandbox.exec).toHaveBeenNthCalledWith(3, "unshare", ["--user", "--map-root-user", "--net", "--mount-proc", "--", "node", "/submission/app.js"], expect.objectContaining({ env: { AGENTBENCH_RESULT: "/result/evaluator-result.json" } }));
  expect(outcome.status).toBe("passed");
  expect(sandbox.writeFile).toHaveBeenCalledWith("/submission/app.js", "ok");
  expect(sandbox.writeFile.mock.calls.find(([path]) => path === "/benchmark/prompt.md")?.[1]).toBeDefined();
  expect(evaluatorContext.resources.registerFinalizer).toHaveBeenCalledWith("cmd", expect.any(Function));
});

test("publishes evaluator-owned evidence when sealed inputs remain unchanged", async () => {
  const sandbox = fakeSandbox();
  const evaluatorContext = await context(sandbox);
  await new CommandEvaluator().evaluate({ id: "cmd", type: "command", weight: 100, enabled: true, prerequisites: [], config: { argv: ["true"], network: true } }, evaluatorContext, new AbortController().signal);
  const finalizer = vi.mocked(evaluatorContext.resources.registerFinalizer).mock.calls[0][1];

  const result = await finalizer();

  expect(result).toMatchObject({ ok: true, metadata: { inputIntegrity: true } });
  expect(evaluatorContext.evidence.putJson).toHaveBeenCalledWith(expect.objectContaining({ evaluatorId: "cmd", role: "input-integrity", producer: "evaluator" }));
});

test("reports changed, added, and deleted sealed inputs as an evaluator error", async () => {
  const sandbox = fakeSandbox();
  const evaluatorContext = await context(sandbox);
  await new CommandEvaluator().evaluate({ id: "cmd", type: "command", weight: 100, enabled: true, prerequisites: [], config: { argv: ["true"], network: true } }, evaluatorContext, new AbortController().signal);
  sandbox.files.set("/submission/app.js", new TextEncoder().encode("changed"));
  sandbox.files.set("/submission/extra.txt", new TextEncoder().encode("new"));
  sandbox.files.delete("/benchmark/prompt.md");
  const finalizer = vi.mocked(evaluatorContext.resources.registerFinalizer).mock.calls[0][1];

  const result = await finalizer();

  expect(result).toMatchObject({ ok: false, metadata: { inputIntegrity: false } });
  expect(evaluatorContext.evidence.putJson).toHaveBeenCalledWith(expect.objectContaining({
    value: expect.objectContaining({
      added: ["/submission/extra.txt"],
      deleted: ["/benchmark/prompt.md"],
      changed: ["/submission/app.js"],
    }),
  }));
});

test("detects tampering by a background process after browser dependents can run", async () => {
  const sandbox = fakeSandbox();
  sandbox.previewUrl.mockResolvedValue({ url: "https://preview.test" });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 })));
  const evaluatorContext = await context(sandbox);
  try {
    await new CommandEvaluator().evaluate({
      id: "serve",
      type: "command",
      weight: 100,
      enabled: true,
      prerequisites: [],
      config: {
        argv: ["node", "/submission/app.js"],
        network: true,
        background: true,
        publishPort: 3000,
      },
    }, evaluatorContext, new AbortController().signal);
    sandbox.files.set("/submission/app.js", new TextEncoder().encode("late mutation"));
    const finalizer = vi.mocked(evaluatorContext.resources.registerFinalizer).mock.calls[0][1];

    await expect(finalizer()).resolves.toMatchObject({
      ok: false,
      metadata: { inputIntegrity: false },
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

test("fails closed and records evidence when final integrity enumeration breaks", async () => {
  const sandbox = fakeSandbox();
  const evaluatorContext = await context(sandbox);
  await new CommandEvaluator().evaluate({ id: "cmd", type: "command", weight: 100, enabled: true, prerequisites: [], config: { argv: ["true"], network: true } }, evaluatorContext, new AbortController().signal);
  sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "find unavailable" });
  const finalizer = vi.mocked(evaluatorContext.resources.registerFinalizer).mock.calls[0][1];

  const result = await finalizer();

  expect(result).toMatchObject({ ok: false, metadata: { inputIntegrity: false } });
  expect(evaluatorContext.evidence.putJson).toHaveBeenCalledWith(expect.objectContaining({
    value: expect.objectContaining({
      ok: false,
      verificationError: expect.stringMatching(/enumeration.*find unavailable/i),
    }),
  }));
});

test("maps command exits to failed assertions and network infrastructure failures to errors", async () => {
  const sandbox = fakeSandbox(2);
  expect((await new CommandEvaluator().evaluate({ id: "cmd", type: "command", weight: 100, enabled: true, prerequisites: [], config: { argv: ["false"], network: true } }, await context(sandbox), new AbortController().signal)).status).toBe("failed");
  const unsupported = fakeSandbox();
  unsupported.exec
    .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
    .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "denied" });
  await expect(new CommandEvaluator().evaluate({ id: "cmd", type: "command", weight: 100, enabled: true, prerequisites: [], config: { argv: ["true"] } }, await context(unsupported), new AbortController().signal)).rejects.toThrow(/network isolation/i);
});

test("treats a malformed declared result file as an evaluator error", async () => {
  const sandbox = fakeSandbox(); sandbox.readFile.mockResolvedValue(new TextEncoder().encode("not json"));
  await expect(new CommandEvaluator().evaluate({ id: "cmd", type: "command", weight: 100, enabled: true, prerequisites: [], config: { argv: ["true"], network: true } }, await context(sandbox), new AbortController().signal)).rejects.toThrow(/json/i);
});
