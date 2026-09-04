import { AgentFailedError, ProviderIncompatibleError } from "../errors";

export const MODEL_RESPONSE_MAX_BYTES = 10 * 1024 * 1024;

export function endpoint(baseUrl: string, path: string, providerId: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ProviderIncompatibleError(providerId, `${providerId} base URL is invalid`);
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new ProviderIncompatibleError(providerId, `${providerId} base URL must use HTTPS`);
  }
  return `${parsed.toString().replace(/\/$/, "")}${path}`;
}

export async function readJsonResponse(response: Response, providerId: string): Promise<unknown> {
  if (!response.ok) {
    throw new AgentFailedError(`${providerId} request failed with status ${response.status}`, providerId);
  }
  if (!response.body) {
    throw new AgentFailedError(`${providerId} returned an empty response`, providerId);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    total += item.value.byteLength;
    if (total > MODEL_RESPONSE_MAX_BYTES) {
      await reader.cancel();
      throw new AgentFailedError(`${providerId} response exceeded 10 MiB`, providerId);
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AgentFailedError(`${providerId} returned malformed JSON`, providerId);
  }
}
