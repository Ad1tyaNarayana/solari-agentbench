import { z } from "zod";
import type { StudioApiPort } from "@/server/authoring-contracts";
import { dataResponse, errorResponse, jsonBody, noStore } from "@/server/studio-route";
export const dynamic = "force-dynamic";
const Body = z.object({ draft: z.record(z.string(), z.unknown()) }).strict();
async function api(): Promise<StudioApiPort> { return (await import("@/server/container")).getServerContainer() as StudioApiPort; }
export async function handleGetBenchmarks(port?: StudioApiPort) { try { return dataResponse(await (port ?? await api()).listBenchmarks()); } catch (error) { return errorResponse(error); } }
export async function handlePostBenchmarks(request: Request, port?: StudioApiPort) { try { const body = Body.parse(await jsonBody(request)); return dataResponse(await (port ?? await api()).createBenchmark(body as never), 201); } catch (error) { if (error instanceof z.ZodError || error instanceof SyntaxError) return Response.json({ error: { code: "invalid_request" } }, { status: 400, headers: noStore }); if ((error as { status?: number }).status === 413) return Response.json({ error: { code: "request_too_large" } }, { status: 413, headers: noStore }); return errorResponse(error); } }
export const GET = () => handleGetBenchmarks();
export const POST = (request: Request) => handlePostBenchmarks(request);
