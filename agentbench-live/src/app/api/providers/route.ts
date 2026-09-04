import { handleGetProviders } from "@/server/provider-handlers";
export const dynamic = "force-dynamic";
export const GET = () => handleGetProviders();
