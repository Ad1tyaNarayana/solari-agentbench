import type { RunApiPort } from "@/server/contracts";
async function api(): Promise<RunApiPort> { return (await import("@/server/container")).getServerContainer(); }
export async function handleCancelRun(id: string, port?: Pick<RunApiPort, "cancelRun">): Promise<Response> { const run = (port ?? await api()).cancelRun(id); return run ? Response.json(run, { status: 202 }) : Response.json({ error: "run_not_found" }, { status: 404 }); }
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) { return handleCancelRun((await context.params).id); }
