import { AuthoringError } from "@/core/authoring/types";

export const noStore = { "Cache-Control": "no-store" };
export function dataResponse(data: unknown, status = 200): Response { return Response.json({ data }, { status, headers: noStore }); }
export function errorResponse(error: unknown): Response {
  if (typeof error === "object" && error !== null && "status" in error && error.status === 413) return Response.json({ error: { code: "request_too_large", message: "Request exceeds 2 MiB" } }, { status: 413, headers: noStore });
  if (error instanceof AuthoringError) {
    const status = error.code === "benchmark_not_found" ? 404 : error.code === "benchmark_conflict" ? 409 : error.code === "benchmark_invalid" ? 422 : 403;
    return Response.json({ error: { code: error.code, message: error.message, changedPaths: error.changedPaths, diagnostics: error.diagnostics } }, { status, headers: noStore });
  }
  return Response.json({ error: { code: "internal_error", message: "Studio request failed" } }, { status: 500, headers: noStore });
}
export async function jsonBody(request: Request): Promise<unknown> { const length = Number(request.headers.get("content-length") ?? 0); if (length > 2 * 1024 * 1024) throw Object.assign(new Error("Request too large"), { status: 413 }); const text = await request.text(); if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw Object.assign(new Error("Request too large"), { status: 413 }); return JSON.parse(text); }
