import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { AuthoringRevision, RenderedBenchmarkFile } from "./types";

const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function renderedRevision(files: RenderedBenchmarkFile[]): AuthoringRevision { return Object.fromEntries(files.map((file) => [file.path, sha(file.contents)])); }
export function renderedDigest(files: RenderedBenchmarkFile[]): string { const hash = createHash("sha256"); for (const file of files) hash.update(file.path).update("\0").update(file.contents).update("\0"); return hash.digest("hex"); }
export async function readRevision(root: string): Promise<AuthoringRevision> {
  const result: AuthoringRevision = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name); const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Symlinks are not allowed in benchmark packs: ${relative(root, path)}`);
      if (info.isDirectory()) await visit(path); else if (info.isFile()) result[relative(root, path).replaceAll("\\", "/")] = sha(await readFile(path));
    }
  };
  await visit(root);
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
export function changedRevisionPaths(expected: AuthoringRevision, actual: AuthoringRevision): string[] { return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].filter((path) => expected[path] !== actual[path]).sort(); }
