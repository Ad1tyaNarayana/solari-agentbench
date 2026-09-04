import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolvePackFile } from "./paths";
export type BenchmarkSnapshot = { digest: string; root: string; files: ReadonlyArray<{ path: string; digest: string; size: number }> };
export async function createBenchmarkSnapshot(input: { packRoot: string; semanticFiles: string[]; snapshotsRoot: string }): Promise<BenchmarkSnapshot> {
  const paths = [...new Set(input.semanticFiles.map((p) => p.replaceAll("\\", "/")))].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
  const entries: Array<{ path: string; digest: string; size: number; content: Buffer }> = [];
  const hash = createHash("sha256");
  for (const path of paths) { const content = await readFile(await resolvePackFile(input.packRoot, path)); const digest = createHash("sha256").update(content).digest("hex"); entries.push({ path, digest, size: content.length, content }); hash.update(Buffer.from(String(Buffer.byteLength(path)))); hash.update(Buffer.from([0])); hash.update(Buffer.from(path)); hash.update(Buffer.from(String(content.length))); hash.update(Buffer.from([0])); hash.update(content); }
  const digest = hash.digest("hex"); await mkdir(input.snapshotsRoot, { recursive: true }); const temporary = join(input.snapshotsRoot, `.tmp-${randomUUID()}`); const root = join(input.snapshotsRoot, digest); await mkdir(temporary, { recursive: true });
  try { for (const entry of entries) { const target = join(temporary, ...entry.path.split("/")); await mkdir(dirname(target), { recursive: true }); await writeFile(target, entry.content); } const manifest = { digest, files: entries.map(({ path, digest: d, size }) => ({ path, digest: d, size })) }; await writeFile(join(temporary, "manifest.json"), JSON.stringify(manifest)); try { await rename(temporary, root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; const existing = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")); if (JSON.stringify(existing) !== JSON.stringify(manifest)) throw new Error("snapshot manifest mismatch"); await rm(temporary, { recursive: true, force: true }); } } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
  const files = Object.freeze(entries.map(({ path, digest: d, size }) => Object.freeze({ path, digest: d, size }))); return Object.freeze({ digest, root, files });
}
