import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { resolvePackFile } from "./paths";

export type BenchmarkSnapshot = {
  digest: string;
  root: string;
  files: ReadonlyArray<{ path: string; digest: string; size: number }>;
};

export type BenchmarkSnapshotSourceFile = Readonly<{
  path: string;
  content: Buffer;
}>;

type CreateBenchmarkSnapshotInput =
  | {
      packRoot: string;
      semanticFiles: string[];
      snapshotsRoot: string;
    }
  | {
      files: ReadonlyArray<BenchmarkSnapshotSourceFile>;
      snapshotsRoot: string;
    };

export function compareUtf8Bytes(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function normalizeSemanticPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.includes("\0") ||
    isAbsolute(path) ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error("path escapes benchmark root");
  }
  return normalized;
}

async function materializeSourceFiles(
  input: CreateBenchmarkSnapshotInput,
): Promise<BenchmarkSnapshotSourceFile[]> {
  if ("files" in input) {
    return input.files.map((file) => ({
      path: normalizeSemanticPath(file.path),
      content: Buffer.from(file.content),
    }));
  }

  const paths = [
    ...new Set(input.semanticFiles.map(normalizeSemanticPath)),
  ].sort(compareUtf8Bytes);
  return Promise.all(
    paths.map(async (path) => ({
      path,
      content: await readFile(await resolvePackFile(input.packRoot, path)),
    })),
  );
}

async function verifyExistingSnapshot(
  root: string,
  manifest: {
    digest: string;
    files: Array<{ path: string; digest: string; size: number }>;
  },
  entries: Array<{
    path: string;
    digest: string;
    size: number;
    content: Buffer;
  }>,
): Promise<void> {
  const existing = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  if (JSON.stringify(existing) !== JSON.stringify(manifest)) {
    throw new Error("snapshot manifest mismatch");
  }

  const actual: string[] = [];
  async function walk(dir: string, prefix = "") {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) await walk(join(dir, item.name), path);
      else actual.push(path);
    }
  }
  await walk(root);

  const expected = new Set(["manifest.json", ...entries.map((entry) => entry.path)]);
  if (actual.length !== expected.size || actual.some((path) => !expected.has(path))) {
    throw new Error("unexpected snapshot file");
  }
  for (const entry of entries) {
    const stored = await readFile(join(root, ...entry.path.split("/")));
    if (
      stored.length !== entry.size ||
      createHash("sha256").update(stored).digest("hex") !== entry.digest
    ) {
      throw new Error("snapshot digest mismatch");
    }
  }
}

export async function createBenchmarkSnapshot(
  input: CreateBenchmarkSnapshotInput,
): Promise<BenchmarkSnapshot> {
  const sourceFiles = await materializeSourceFiles(input);
  const contentByPath = new Map<string, Buffer>();
  for (const sourceFile of sourceFiles) {
    const path = normalizeSemanticPath(sourceFile.path);
    const existing = contentByPath.get(path);
    if (existing && !existing.equals(sourceFile.content)) {
      throw new Error(`conflicting benchmark snapshot bytes: ${path}`);
    }
    if (!existing) contentByPath.set(path, Buffer.from(sourceFile.content));
  }

  const entries = [...contentByPath]
    .sort(([left], [right]) => compareUtf8Bytes(left, right))
    .map(([path, content]) => ({
      path,
      digest: createHash("sha256").update(content).digest("hex"),
      size: content.length,
      content,
    }));
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(Buffer.from(String(Buffer.byteLength(entry.path))));
    hash.update(Buffer.from([0]));
    hash.update(Buffer.from(entry.path));
    hash.update(Buffer.from(String(entry.content.length)));
    hash.update(Buffer.from([0]));
    hash.update(entry.content);
  }

  const digest = hash.digest("hex");
  await mkdir(input.snapshotsRoot, { recursive: true });
  const temporary = join(input.snapshotsRoot, `.tmp-${randomUUID()}`);
  const root = join(input.snapshotsRoot, digest);
  await mkdir(temporary, { recursive: true });
  const manifest = {
    digest,
    files: entries.map(({ path, digest: entryDigest, size }) => ({
      path,
      digest: entryDigest,
      size,
    })),
  };

  try {
    for (const entry of entries) {
      const target = join(temporary, ...entry.path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, entry.content);
    }
    await writeFile(join(temporary, "manifest.json"), JSON.stringify(manifest));
    try {
      await rename(temporary, root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["EEXIST", "EPERM", "ENOTEMPTY"].includes(code ?? "")) throw error;
      await verifyExistingSnapshot(root, manifest, entries);
      await rm(temporary, { recursive: true, force: true });
    }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }

  const files = Object.freeze(
    entries.map(({ path, digest: entryDigest, size }) =>
      Object.freeze({ path, digest: entryDigest, size }),
    ),
  );
  return Object.freeze({ digest, root, files });
}
