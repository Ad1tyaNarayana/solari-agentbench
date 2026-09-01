import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  defaultSubmissionPolicy,
  packageSubmission,
} from "@/core/security/package-submission";
import { redact } from "@/core/security/redact";
import { createWorkspace } from "@/core/security/workspace";

const fixtures: string[] = [];

async function fixtureWorkspace(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "agentbench-fixture-"));
  fixtures.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const destination = join(root, relativePath);
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, contents);
  }
  return { root, dispose: async () => undefined };
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("redacts keys, bearer headers, signed session URLs, and local roots", () => {
  const input =
    "Bearer slr_live_id_secret https://stream.getsolari.com/signed C:\\Users\\Admin\\repo";
  expect(
    redact(input, { localRoots: ["C:\\Users\\Admin\\repo"] }),
  ).not.toMatch(/secret|signed|Users\\Admin/);
});

test("rejects dotenv files", async () => {
  const workspace = await fixtureWorkspace({
    "submission/results.json": "{}",
    "submission/.env": "SOLARI_API_KEY=leak",
  });
  await expect(
    packageSubmission(workspace, defaultSubmissionPolicy),
  ).rejects.toThrow(/\.env/);
});

test("rejects symlinks inside the submission", async () => {
  const workspace = await fixtureWorkspace({
    "submission/results.json": "{}",
    "outside/not-submission-data.txt": "not submission data",
  });
  await symlink(
    join(workspace.root, "outside"),
    join(workspace.root, "submission", "linked"),
    "junction",
  );
  await expect(
    packageSubmission(workspace, defaultSubmissionPolicy),
  ).rejects.toThrow(/symlink/i);
});

test("requires valid results JSON", async () => {
  const workspace = await fixtureWorkspace({
    "submission/results.json": "not json",
  });
  await expect(
    packageSubmission(workspace, defaultSubmissionPolicy),
  ).rejects.toThrow(/results\.json/i);
});

test("hashes sorted submission paths and bytes", async () => {
  const workspace = await fixtureWorkspace({
    "submission/results.json": "{}",
    "submission/methodology.md": "method",
  });
  const packaged = await packageSubmission(workspace, defaultSubmissionPolicy);
  const expected = createHash("sha256")
    .update("methodology.md\0method")
    .update("results.json\0{}")
    .digest("hex");
  expect(packaged).toEqual({
    entries: {
      "methodology.md": "method",
      "results.json": "{}",
    },
    digest: expected,
  });
});

test("creates a Git workspace and disposes only that workspace", async () => {
  const workspace = await createWorkspace("run-1");
  expect((await lstat(join(workspace.root, ".git"))).isDirectory()).toBe(true);
  await workspace.dispose();
  await expect(lstat(workspace.root)).rejects.toMatchObject({ code: "ENOENT" });
});
