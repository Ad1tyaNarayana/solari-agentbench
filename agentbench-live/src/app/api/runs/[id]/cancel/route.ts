import { handleCancelRun } from "@/server/run-handlers";
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  return handleCancelRun((await context.params).id);
}
