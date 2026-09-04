import { z } from "zod";
import type { RunApiPort } from "@/server/contracts";

const submitSchema = z.object({
  benchmarkId: z.string().min(1).optional(),
  benchmarkDigest: z.string().min(1).optional(),
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  dryRun: z.boolean().optional(),
}).strict();

async function api(): Promise<RunApiPort> {
  return (await import("@/server/container")).getServerContainer();
}

export async function handlePostRuns(request: Request, port?: RunApiPort): Promise<Response> {
  let input: z.infer<typeof submitSchema>;
  try { input = submitSchema.parse(await request.json()); }
  catch { return Response.json({ error: "invalid_request" }, { status: 400 }); }
  try {
    const submission = await (port ?? await api()).submit(input);
    return submission.kind === "dry-run"
      ? Response.json(submission.report)
      : Response.json(submission.run, { status: 202 });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code : "submission_failed";
    const status = code === "preflight_failed" ? 503 : code === "benchmark_conflict" ? 409 : 400;
    return Response.json({ error: code }, { status });
  }
}

export async function handleGetRuns(port?: RunApiPort): Promise<Response> {
  return Response.json((port ?? await api()).listRuns());
}

export async function handleGetRun(id: string, port?: RunApiPort): Promise<Response> {
  const run = (port ?? await api()).getRun(id);
  return run ? Response.json(run) : Response.json({ error: "run_not_found" }, { status: 404 });
}

export async function handleCancelRun(id: string, port?: Pick<RunApiPort, "cancelRun">): Promise<Response> {
  const run = (port ?? await api()).cancelRun(id);
  return run ? Response.json(run, { status: 202 }) : Response.json({ error: "run_not_found" }, { status: 404 });
}
