import { handleGetRun } from "@/server/run-handlers";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return handleGetRun((await context.params).id);
}
