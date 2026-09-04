import { handleGetBenchmarks, handlePostBenchmarks } from "@/server/benchmark-handlers";
export const dynamic = "force-dynamic";
export const GET = () => handleGetBenchmarks();
export const POST = (request: Request) => handlePostBenchmarks(request);
