import type { RunApiPort } from "@/server/contracts";

async function defaultApi(): Promise<RunApiPort> {
  return (await import("@/server/container")).getServerContainer();
}

export async function handleGetRun(
  id: string,
  api?: RunApiPort,
): Promise<Response> {
  const run = (api ?? (await defaultApi())).getRun(id);
  if (!run) {
    return Response.json({ error: "run_not_found" }, { status: 404 });
  }
  return Response.json(run);
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handleGetRun(id);
}
