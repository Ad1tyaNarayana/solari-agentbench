import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DisposableWorkspace } from "./workspace";

export type SubmissionPolicy = {
  maxFileBytes: number;
  secretPatterns: RegExp[];
  allowedBinaryExtensions: Record<string, string>;
};

export type SubmissionEntry =
  | { kind: "text"; contents: string }
  | { kind: "binary"; contents: Uint8Array; mediaType: string };

export type SubmissionPackage = {
  entries: Record<string, SubmissionEntry>;
  digest: string;
};

export const defaultSubmissionPolicy: SubmissionPolicy = {
  maxFileBytes: 2 * 1024 * 1024,
  secretPatterns: [
    /\bslr_(?:live|test)_[A-Za-z0-9_-]+\b/i,
    /Authorization\s*:\s*Bearer/i,
    /SOLARI_API_KEY\s*=/i,
    /(?:^|[\\/])auth\.json$/i,
    /https:\/\/[A-Za-z0-9.-]*getsolari\.com\/[^\s"'<>]*(?:\/signed(?:[/?#]|$)|[?&][^=&\s"'<>]*(?:token|sig|auth|key|credential|expires)[^=&\s"'<>]*=)[^\s"'<>]*/i,
    /(?:["'](?:token|streamToken|previewToken|sessionToken|solari(?:Stream|Preview|Session)?Token)["']|solari(?:Stream|Preview|Session)?Token)\s*[:=]\s*["'][A-Za-z0-9._~+\/-]{12,}={0,2}["']/i,
  ],
  allowedBinaryExtensions: {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
  },
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

function containsSecret(bytes: Uint8Array, patterns: RegExp[]): boolean {
  const buffer = Buffer.from(bytes);
  const representations = [buffer.toString("utf8"), buffer.toString("latin1")];
  return patterns.some((pattern) => {
    const expression = new RegExp(pattern.source, pattern.flags.replace("g", ""));
    return representations.some((value) => expression.test(value));
  });
}

function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function validateBinary(
  relativePath: string,
  bytes: Uint8Array,
  policy: SubmissionPolicy,
): { mediaType: string } {
  const extension = relativePath.slice(relativePath.lastIndexOf(".")).toLowerCase();
  const mediaType = policy.allowedBinaryExtensions[extension];
  if (!mediaType) {
    throw new Error(`Binary files are not allowed: ${relativePath}`);
  }
  const buffer = Buffer.from(bytes);
  if (mediaType === "image/png") {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const iend = buffer.subarray(-8, -4).toString("ascii");
    if (buffer.length < 20 || !buffer.subarray(0, 8).equals(signature) || iend !== "IEND") {
      throw new Error(`Invalid PNG artifact: ${relativePath}`);
    }
  } else if (mediaType === "image/jpeg") {
    if (
      buffer.length < 4 ||
      buffer[0] !== 0xff ||
      buffer[1] !== 0xd8 ||
      buffer[2] !== 0xff ||
      buffer.at(-2) !== 0xff ||
      buffer.at(-1) !== 0xd9
    ) {
      throw new Error(`Invalid JPEG artifact: ${relativePath}`);
    }
  }
  return { mediaType };
}

export function submissionText(
  submission: SubmissionPackage,
  relativePath: string,
): string | undefined {
  const entry = submission.entries[relativePath];
  return entry?.kind === "text" ? entry.contents : undefined;
}

export async function packageSubmission(
  workspace: Pick<DisposableWorkspace, "root">,
  policy: SubmissionPolicy,
): Promise<SubmissionPackage> {
  const submissionRoot = resolve(workspace.root, "submission");
  const canonicalRoot = await realpath(submissionRoot);
  const entries: Record<string, SubmissionEntry> = {};

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
      if (containsSecret(bytes, policy.secretPatterns)) {
        throw new Error(`Secret material found in: ${relativePath}`);
      }
      const contents = decodeText(bytes);
      const extension = relativePath
        .slice(relativePath.lastIndexOf("."))
        .toLowerCase();
      const declaredBinary = extension in policy.allowedBinaryExtensions;
      entries[relativePath] = contents === undefined || declaredBinary
        ? {
            kind: "binary",
            contents: bytes,
            mediaType: validateBinary(relativePath, bytes, policy).mediaType,
          }
        : { kind: "text", contents };
    }
  }

  await visit(submissionRoot);
  if (!("results.json" in entries)) {
    throw new Error("submission/results.json is required");
  }
  try {
    const results = submissionText({ entries, digest: "" }, "results.json");
    if (results === undefined) throw new Error("submission/results.json must be text");
    JSON.parse(results);
  } catch {
    throw new Error("submission/results.json must contain valid JSON");
  }

  const hash = createHash("sha256");
  for (const relativePath of Object.keys(entries).sort()) {
    hash.update(relativePath).update("\0").update(entries[relativePath].contents);
  }
  return { entries, digest: hash.digest("hex") };
}
