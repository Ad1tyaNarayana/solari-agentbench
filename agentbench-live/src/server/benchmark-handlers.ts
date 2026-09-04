import { z } from "zod";
import type { StudioApiPort } from "@/server/authoring-contracts";
import { dataResponse, errorResponse, jsonBody, noStore } from "@/server/studio-route";

const CreateBody = z.object({ draft: z.record(z.string(), z.unknown()) }).strict();
const SaveBody = z.object({
  expectedRevision: z.record(z.string(), z.string()),
  draft: z.record(z.string(), z.unknown()),
}).strict();

async function api(): Promise<StudioApiPort> {
  return (await import("@/server/container")).getServerContainer() as StudioApiPort;
}

export async function handleGetBenchmarks(port?: StudioApiPort) {
  try { return dataResponse(await (port ?? await api()).listBenchmarks()); }
  catch (error) { return errorResponse(error); }
}

export async function handlePostBenchmarks(request: Request, port?: StudioApiPort) {
  try {
    const body = CreateBody.parse(await jsonBody(request));
    return dataResponse(await (port ?? await api()).createBenchmark(body as never), 201);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return invalidRequest();
    if ((error as { status?: number }).status === 413) return Response.json({ error: { code: "request_too_large" } }, { status: 413, headers: noStore });
    return errorResponse(error);
  }
}

export async function handleGetBenchmark(id: string, port?: StudioApiPort) {
  try { return dataResponse(await (port ?? await api()).readBenchmark(id)); }
  catch (error) { return errorResponse(error); }
}

export async function handlePutBenchmark(id: string, request: Request, port?: StudioApiPort) {
  try {
    const body = SaveBody.parse(await jsonBody(request));
    return dataResponse(await (port ?? await api()).saveBenchmark({
      packId: id, expectedRevision: body.expectedRevision, draft: body.draft as never,
    }));
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return invalidRequest();
    return errorResponse(error);
  }
}

export async function handlePreviewBenchmark(request: Request, port?: StudioApiPort) {
  try {
    const body = CreateBody.parse(await jsonBody(request));
    return dataResponse(await (port ?? await api()).previewBenchmark(body.draft as never));
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return invalidRequest();
    return errorResponse(error);
  }
}

function invalidRequest() {
  return Response.json({ error: { code: "invalid_request" } }, { status: 400, headers: noStore });
}
