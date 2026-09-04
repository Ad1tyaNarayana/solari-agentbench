import { handleGetProviders, handleGetCredentials } from "@/server/provider-handlers";

test("returns capabilities and credential metadata without secret values", async () => {
  const api = { listProviders: () => [{ id: "codex", capabilities: { tools: true } }], listCredentials: async () => [{ ref: "anthropic-main", label: "Claude", source: "environment", configured: true }] };
  const providers = await handleGetProviders(api as never); expect((await providers.json()).data[0].id).toBe("codex");
  const credentials = await handleGetCredentials(api as never); const text = await credentials.text(); expect(text).toContain("anthropic-main"); expect(text).not.toMatch(/api.?key|secret|token/i); expect(credentials.headers.get("cache-control")).toBe("no-store");
});
