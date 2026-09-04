import { handleGetCredentials } from "@/server/provider-handlers";
export const dynamic = "force-dynamic";
export const GET = () => handleGetCredentials();
