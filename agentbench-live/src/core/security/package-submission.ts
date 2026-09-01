import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DisposableWorkspace } from "./workspace";

export type SubmissionPolicy = {
  maxFileBytes: number;
  secretPatterns: RegExp[];
};

export type SubmissionPackage = {
  entries: Record<string, string>;
  digest: string;
};

export const defaultSubmissionPolicy: SubmissionPolicy = {
  maxFileBytes: 2 * 1024 * 1024,
  secretPatterns: [
    /\bslr_(?:live|test)_[A-Za-z0-9_-]+\b/i,
    /Authorization\s*:\s*Bearer/i,
    /SOLARI_API_KEY\s*=/i,
    /(?:^|[\\/])auth\.json$/i,
  ],
};

const deniedDirectories = new Set([
  ".codex",
  "node_modules",
  ".venv",
  "__pycache__",
  ".next",
  "dist",
]);

function assertAllowedName(relativePath: string): void {
  const segments = relativePath.split(/[\\/]/);
  const filename = segments.at(-1) ?? "";
  if (segments.some((segment) => deniedDirectories.has(segment))) {
    throw new Error(`Denied dependency or cache path: ${relativePath}`);
  }
  if (/^\.env(?:\.|$)/i.test(filename) || /^auth\.json$/i.test(filename)) {
    throw new Error(`Denied credential file: ${relativePath}`);
  }
}

function assertInside(root: string, candidate: string): void {
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error(`Submission path escapes root: ${candidate}`);
  }
}

function containsSecret(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) =>
    new RegExp(pattern.source, pattern.flags.replace("g", "")).test(value),
  );
}

export async function packageSubmission(
  workspace: Pick<DisposableWorkspace, "root">,
  policy: SubmissionPolicy,
): Promise<SubmissionPackage> {
  const submissionRoot = resolve(workspace.root, "submission");
  const canonicalRoot = await realpath(submissionRoot);
  const entries: Record<string, string> = {};

  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const absolutePath = resolve(directory, child.name);
      const relativePath = relative(submissionRoot, absolutePath).replaceAll(
        sep,
        "/",
      );
      assertAllowedName(relativePath);

      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Symlinks are not allowed: ${relativePath}`);
      }
      const canonicalPath = await realpath(absolutePath);
      assertInside(canonicalRoot, canonicalPath);

      if (metadata.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(`Unsupported submission entry: ${relativePath}`);
      }
      if (metadata.size > policy.maxFileBytes) {
        throw new Error(`Submission file exceeds size limit: ${relativePath}`);
      }

      const bytes = await readFile(absolutePath);
      if (bytes.includes(0)) {
        throw new Error(`Binary files are not allowed: ${relativePath}`);
      }
      const contents = bytes.toString("utf8");
      if (containsSecret(contents, policy.secretPatterns)) {
        throw new Error(`Secret material found in: ${relativePath}`);
      }
      entries[relativePath] = contents;
    }
  }

  await visit(submissionRoot);
  if (!("results.json" in entries)) {
    throw new Error("submission/results.json is required");
  }
  try {
    JSON.parse(entries["results.json"]);
  } catch {
    throw new Error("submission/results.json must contain valid JSON");
  }

  const hash = createHash("sha256");
  for (const relativePath of Object.keys(entries).sort()) {
    hash.update(relativePath).update("\0").update(entries[relativePath]);
  }
  return { entries, digest: hash.digest("hex") };
}
