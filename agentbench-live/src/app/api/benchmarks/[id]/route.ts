import { handleGetBenchmark, handlePutBenchmark } from "@/server/benchmark-handlers";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return handleGetBenchmark((await context.params).id);
}
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  return handlePutBenchmark((await context.params).id, request);
}
