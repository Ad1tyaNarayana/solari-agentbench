import { z } from "zod";
import type { StudioApiPort } from "@/server/authoring-contracts";
import { dataResponse, errorResponse, jsonBody, noStore } from "@/server/studio-route";
export const dynamic = "force-dynamic";
const Body = z.object({ expectedRevision: z.record(z.string(), z.string()), draft: z.record(z.string(), z.unknown()) }).strict();
async function api(): Promise<StudioApiPort> { return (await import("@/server/container")).getServerContainer() as StudioApiPort; }
export async function handleGetBenchmark(id: string, port?: StudioApiPort) { try { return dataResponse(await (port ?? await api()).readBenchmark(id)); } catch (error) { return errorResponse(error); } }
export async function handlePutBenchmark(id: string, request: Request, port?: StudioApiPort) { try { const body = Body.parse(await jsonBody(request)); return dataResponse(await (port ?? await api()).saveBenchmark({ packId: id, expectedRevision: body.expectedRevision, draft: body.draft as never })); } catch (error) { if (error instanceof z.ZodError || error instanceof SyntaxError) return Response.json({ error: { code: "invalid_request" } }, { status: 400, headers: noStore }); return errorResponse(error); } }
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) { return handleGetBenchmark((await context.params).id); }
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) { return handlePutBenchmark((await context.params).id, request); }
