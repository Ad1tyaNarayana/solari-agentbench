import { z } from "zod";
import type { StudioApiPort } from "@/server/authoring-contracts";
import { dataResponse, errorResponse, jsonBody, noStore } from "@/server/studio-route";
const Body = z.object({ draft: z.record(z.string(), z.unknown()) }).strict();
async function api(): Promise<StudioApiPort> { return (await import("@/server/container")).getServerContainer() as StudioApiPort; }
export async function handlePreviewBenchmark(request: Request, port?: StudioApiPort) { try { const body = Body.parse(await jsonBody(request)); return dataResponse(await (port ?? await api()).previewBenchmark(body.draft as never)); } catch (error) { if (error instanceof z.ZodError || error instanceof SyntaxError) return Response.json({ error: { code: "invalid_request" } }, { status: 400, headers: noStore }); return errorResponse(error); } }
export const POST = (request: Request) => handlePreviewBenchmark(request);
