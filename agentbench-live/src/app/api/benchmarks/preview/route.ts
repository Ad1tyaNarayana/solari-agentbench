import { handlePreviewBenchmark } from "@/server/benchmark-handlers";
export const POST = (request: Request) => handlePreviewBenchmark(request);
