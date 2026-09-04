import { createHash } from "node:crypto";
import { posix } from "node:path";
import { compareUtf8Bytes, type BenchmarkSnapshot } from "@/core/benchmarks/snapshot";
import type { SubmissionEntry, SubmissionPackage } from "@/core/security/package-submission";
import type { SandboxHandle } from "@/core/solari/contracts";

export type InputSealEntry = {
  path: string;
  size: number;
  digest: string;
};

export type InputSealManifest = {
  schemaVersion: 1;
  files: InputSealEntry[];
};

export type InputSealReport = {
  schemaVersion: 1;
  ok: boolean;
  expectedFileCount: number;
  observedFileCount: number;
  added: string[];
  deleted: string[];
  changed: string[];
};

type SealSandbox = Pick<SandboxHandle, "exec" | "readFile">;

function entryBytes(entry: SubmissionEntry): Uint8Array {
  return typeof entry.contents === "string"
    ? Buffer.from(entry.contents)
    : entry.contents;
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function buildInputSeal(
  snapshot: BenchmarkSnapshot,
  submission: SubmissionPackage,
): InputSealManifest {
  const files: InputSealEntry[] = snapshot.files.map((file) => ({
    path: posix.join("/benchmark", file.path),
    size: file.size,
    digest: file.digest,
  }));

  for (const [path, entry] of Object.entries(submission.entries)) {
    const bytes = entryBytes(entry);
    files.push({
      path: posix.join("/submission", path),
      size: bytes.byteLength,
      digest: hash(bytes),
    });
  }

  files.sort((left, right) => compareUtf8Bytes(left.path, right.path));
  return { schemaVersion: 1, files };
}

export async function verifyInputSeal(
  sandbox: SealSandbox,
  manifest: InputSealManifest,
): Promise<InputSealReport> {
  const listing = await sandbox.exec("find", [
    "/benchmark",
    "/submission",
    "-type",
    "f",
    "-print0",
  ]);
  if (listing.exitCode !== 0) {
    throw new Error(
      `Input-tree enumeration failed: ${listing.stderr || `find exited with ${listing.exitCode}`}`,
    );
  }

  const paths = listing.stdout
    .split("\0")
    .filter(Boolean)
    .sort(compareUtf8Bytes);
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  const observed = new Set(paths);
  const added = paths.filter((path) => !expected.has(path));
  const deleted = manifest.files
    .map((file) => file.path)
    .filter((path) => !observed.has(path));
  const changed: string[] = [];

  for (const path of paths) {
    const expectedFile = expected.get(path);
    if (!expectedFile) continue;
    const bytes = await sandbox.readFile(path);
    if (bytes.byteLength !== expectedFile.size || hash(bytes) !== expectedFile.digest) {
      changed.push(path);
    }
  }

  return {
    schemaVersion: 1,
    ok: added.length === 0 && deleted.length === 0 && changed.length === 0,
    expectedFileCount: manifest.files.length,
    observedFileCount: paths.length,
    added,
    deleted,
    changed,
  };
}
