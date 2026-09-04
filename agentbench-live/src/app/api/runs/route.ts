import { handleGetRuns, handlePostRuns } from "@/server/run-handlers";
export const POST = (request: Request) => handlePostRuns(request);
export const GET = () => handleGetRuns();
