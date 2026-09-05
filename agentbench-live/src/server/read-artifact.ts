import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import type { EvidenceManifest } from "@/core/evidence/manifest";

export async function readRunArtifact(root: string, runId: string, taskId: string, digest: string, manifest?: EvidenceManifest) {
  if (!/^[a-f0-9]{64}$/.test(digest) || manifest?.runId !== runId || manifest.taskId !== taskId) return;
  const entry = manifest.entries.find(item => item.digest === digest && item.runId === runId && item.taskId === taskId && item.redacted);
  if (!entry) return;
  try {
    const base = await realpath(root);
    const path = await realpath(join(base, "sha256", digest.slice(0, 2), digest));
    const rel = relative(base, path);
    if (isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) return;
    const bytes = await readFile(path);
    if (bytes.length !== entry.size || createHash("sha256").update(bytes).digest("hex") !== digest) return;
    return { bytes, mimeType: entry.mimeType };
  } catch { return; }
}
