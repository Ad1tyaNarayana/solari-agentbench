import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  defaultSubmissionPolicy,
  packageSubmission,
} from "@/core/security/package-submission";
import { redact } from "@/core/security/redact";
import { createWorkspace } from "@/core/security/workspace";

const fixtures: string[] = [];

async function fixtureWorkspace(files: Record<string, string | Uint8Array>) {
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

test("rejects signed Solari URLs and Solari token fields", async () => {
  const workspace = await fixtureWorkspace({
    "submission/results.json": "{}",
    "submission/provenance.json": JSON.stringify({
      replay: "https://stream.getsolari.com/session/signed?token=top-secret",
      solariStreamToken: "abc1234567890secret",
    }),
  });

  await expect(
    packageSubmission(workspace, defaultSubmissionPolicy),
  ).rejects.toThrow(/secret material/i);
});

test("rejects AWS-style Solari signatures and standalone preview token fields", async () => {
  const signedUrlWorkspace = await fixtureWorkspace({
    "submission/results.json": "{}",
    "submission/provenance.json": JSON.stringify({
      replay:
        "https://stream.getsolari.com/session/123?X-Amz-Signature=abcdef1234567890",
    }),
  });
  const tokenWorkspace = await fixtureWorkspace({
    "submission/results.json": "{}",
    "submission/provenance.json": JSON.stringify({
      token: "abcdef1234567890",
    }),
  });

  await expect(
    packageSubmission(signedUrlWorkspace, defaultSubmissionPolicy),
  ).rejects.toThrow(/secret material/i);
  await expect(
    packageSubmission(tokenWorkspace, defaultSubmissionPolicy),
  ).rejects.toThrow(/secret material/i);
});

test("packages validated allowlisted PNG and JPEG artifacts as binary entries", async () => {
  const png = await readFile(resolve("public/demo/url-shortener-browser.png"));
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xd9]);
  const workspace = await fixtureWorkspace({
    "submission/results.json": "{}",
    "submission/artifacts/proof.png": png,
    "submission/artifacts/proof.jpg": jpeg,
  });

  const packaged = await packageSubmission(workspace, defaultSubmissionPolicy);

  expect(packaged.entries["artifacts/proof.png"]).toMatchObject({
    kind: "binary",
    mediaType: "image/png",
  });
  expect(packaged.entries["artifacts/proof.jpg"]).toMatchObject({
    kind: "binary",
    mediaType: "image/jpeg",
  });
});

test("scans raw binary bytes for secret material before accepting an artifact", async () => {
  const png = await readFile(resolve("public/demo/url-shortener-browser.png"));
  const workspace = await fixtureWorkspace({
    "submission/results.json": "{}",
    "submission/artifacts/proof.png": Buffer.concat([
      png,
      Buffer.from("SOLARI_API_KEY=slr_live_binary_secret", "ascii"),
    ]),
  });

  await expect(
    packageSubmission(workspace, defaultSubmissionPolicy),
  ).rejects.toThrow(/secret material/i);
});

test("rejects binary artifacts outside the explicit extension allowlist", async () => {
  const workspace = await fixtureWorkspace({
    "submission/results.json": "{}",
    "submission/artifacts/archive.zip": new Uint8Array([0x50, 0x4b, 3, 4, 0]),
  });
  await expect(
    packageSubmission(workspace, defaultSubmissionPolicy),
  ).rejects.toThrow(/binary files are not allowed/i);
});

test("rejects a text file masquerading as an allowlisted image artifact", async () => {
  const workspace = await fixtureWorkspace({
    "submission/results.json": "{}",
    "submission/artifacts/not-an-image.png": "this is plain text",
  });
  await expect(
    packageSubmission(workspace, defaultSubmissionPolicy),
  ).rejects.toThrow(/invalid PNG artifact/i);
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
      "methodology.md": { kind: "text", contents: "method" },
      "results.json": { kind: "text", contents: "{}" },
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
