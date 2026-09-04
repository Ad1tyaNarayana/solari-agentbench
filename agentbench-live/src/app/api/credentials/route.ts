import type { StudioApiPort } from "@/server/authoring-contracts";
import { dataResponse } from "@/server/studio-route";
export const dynamic = "force-dynamic";
async function api(): Promise<StudioApiPort> { return (await import("@/server/container")).getServerContainer() as StudioApiPort; }
export async function handleGetCredentials(port?: StudioApiPort) { return dataResponse(await (port ?? await api()).listCredentials()); }
export const GET = () => handleGetCredentials();
