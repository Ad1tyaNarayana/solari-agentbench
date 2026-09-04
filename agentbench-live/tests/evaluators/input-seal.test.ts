import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { buildInputSeal, verifyInputSeal } from "@/core/evaluators/input-seal";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const snapshot = {
  root: "C:\\snapshot",
  digest: "snapshot-digest",
  files: [
    { path: "z-last.txt", digest: digest("last"), size: 4 },
    { path: "prompt.md", digest: digest("prompt"), size: 6 },
  ],
};

const submission = {
  digest: "submission-digest",
  entries: {
    "source/app.js": { kind: "text" as const, contents: "app" },
    "results.json": { kind: "text" as const, contents: "{}" },
  },
};

describe("evaluator input seal", () => {
  test("builds a canonical path-size-digest manifest", () => {
    const manifest = buildInputSeal(snapshot, submission);

    expect(manifest).toEqual({
      schemaVersion: 1,
      files: [
        { path: "/benchmark/prompt.md", size: 6, digest: digest("prompt") },
        { path: "/benchmark/z-last.txt", size: 4, digest: digest("last") },
        { path: "/submission/results.json", size: 2, digest: digest("{}") },
        { path: "/submission/source/app.js", size: 3, digest: digest("app") },
      ],
    });
  });

  test("accepts an unchanged uploaded tree", async () => {
    const files = new Map([
      ["/benchmark/prompt.md", "prompt"],
      ["/benchmark/z-last.txt", "last"],
      ["/submission/results.json", "{}"],
      ["/submission/source/app.js", "app"],
    ]);
    const sandbox = sandboxTree(files);

    await expect(verifyInputSeal(sandbox, buildInputSeal(snapshot, submission)))
      .resolves.toMatchObject({ ok: true, added: [], deleted: [], changed: [] });
  });

  test("reports added, deleted, and changed files without exposing contents", async () => {
    const files = new Map([
      ["/benchmark/prompt.md", "prompt"],
      ["/submission/results.json", "changed"],
      ["/submission/source/app.js", "app"],
      ["/submission/extra.txt", "secret payload"],
    ]);
    const sandbox = sandboxTree(files);

    const report = await verifyInputSeal(
      sandbox,
      buildInputSeal(snapshot, submission),
    );

    expect(report).toMatchObject({
      ok: false,
      added: ["/submission/extra.txt"],
      deleted: ["/benchmark/z-last.txt"],
      changed: ["/submission/results.json"],
    });
    expect(JSON.stringify(report)).not.toContain("secret payload");
  });

  test("fails closed when sandbox enumeration fails", async () => {
    const sandbox = sandboxTree(new Map());
    sandbox.exec.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "find unavailable" });

    await expect(verifyInputSeal(sandbox, buildInputSeal(snapshot, submission)))
      .rejects.toThrow(/enumeration.*find unavailable/i);
  });
});

function sandboxTree(files: Map<string, string>) {
  return {
    exec: vi.fn(async () => ({
      exitCode: 0,
      stdout: `${[...files.keys()].join("\0")}\0`,
      stderr: "",
    })),
    readFile: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) {
        throw Object.assign(new Error(`missing ${path}`), { code: "ENOENT" });
      }
      return new TextEncoder().encode(value);
    }),
  };
}
