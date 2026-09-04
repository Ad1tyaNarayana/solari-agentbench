import { z } from "zod";
import type { RunApiPort } from "@/server/contracts";

const submitSchema = z
  .object({
    benchmarkId: z.string().min(1).optional(),
    taskId: z.string().min(1),
    agentId: z.string().min(1),
    dryRun: z.boolean().optional(),
  })
  .strict();

async function defaultApi(): Promise<RunApiPort> {
  return (await import("@/server/container")).getServerContainer();
}

export async function handlePostRuns(
  request: Request,
  api?: RunApiPort,
): Promise<Response> {
  let input: z.infer<typeof submitSchema>;
  try {
    input = submitSchema.parse(await request.json());
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const submission = await (api ?? (await defaultApi())).submit(input);
    if (submission.kind === "dry-run") {
      return Response.json(submission.report);
    }
    return Response.json(submission.run, { status: 202 });
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "submission_failed";
    const status = code === "preflight_failed" ? 503 : 400;
    return Response.json({ error: code }, { status });
  }
}

export async function handleGetRuns(api?: RunApiPort): Promise<Response> {
  return Response.json((api ?? (await defaultApi())).listRuns());
}

export function POST(request: Request): Promise<Response> {
  return handlePostRuns(request);
}

export function GET(): Promise<Response> {
  return handleGetRuns();
}
