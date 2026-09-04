import { handleGetBenchmarks, handlePostBenchmarks, handlePreviewBenchmark } from "@/server/benchmark-handlers";

const api = { listBenchmarks: vi.fn(async () => [{ id: "demo", name: "Demo", version: "1", writable: true }]), createBenchmark: vi.fn(async (input) => input), previewBenchmark: vi.fn(async () => ({ files: [], diagnostics: [], snapshotDigest: "abc" })) };
test("exposes no-store benchmark metadata and strict preview/create bodies", async () => {
  const listed = await handleGetBenchmarks(api as never); expect(listed.headers.get("cache-control")).toBe("no-store"); expect((await listed.json()).data[0].id).toBe("demo");
  expect((await handlePreviewBenchmark(new Request("http://x", { method: "POST", body: "{}" }), api as never)).status).toBe(400);
  const preview = await handlePreviewBenchmark(new Request("http://x", { method: "POST", body: JSON.stringify({ draft: { id: "demo" } }) }), api as never); expect(preview.status).toBe(200);
  expect((await handlePostBenchmarks(new Request("http://x", { method: "POST", body: JSON.stringify({ draft: { id: "demo" }, extra: true }) }), api as never)).status).toBe(400);
});
