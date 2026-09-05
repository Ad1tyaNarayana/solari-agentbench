import { resolve } from "node:path";
import { getServerContainer } from "@/server/container";
import { readRunArtifact } from "@/server/read-artifact";

export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ id: string; digest: string }> }) {
  const { id, digest } = await context.params;
  const run = getServerContainer().getRun(id);
  const artifact = run && await readRunArtifact(resolve(".agentbench/evidence"), id, run.taskId, digest, run.evidenceManifest);
  if (!artifact) return new Response("Artifact not found", { status: 404 });
  const inline = ["image/png", "image/jpeg", "image/webp", "text/plain", "application/json"].includes(artifact.mimeType);
  return new Response(new Uint8Array(artifact.bytes), { headers: {
    "Content-Type": inline ? artifact.mimeType : "application/octet-stream",
    "Content-Disposition": inline ? "inline" : `attachment; filename="${digest}"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "private, no-store",
  } });
}
