import { BrowserEvaluator } from "@/core/evaluators/browser";
import type { EvaluatorContext } from "@/core/evaluators/types";

test("persists downloaded replay events rather than relying on an expiring URL", async () => {
  const saved: unknown[] = [];
  const context = { resources: { acquireBrowser: async () => ({ id: "b", newPage: async () => ({ goto: async () => {}, url: () => "https://app.test" }) }), releaseBrowser: async () => {} }, evidence: { putJson: async (input: unknown) => { saved.push(input); return { role: "browser-replay" }; } }, remainingMs: () => 60000 } as unknown as EvaluatorContext;
  const outcome = await new BrowserEvaluator({ getReplayUrl: async () => ({ url: "https://replay.test", expiresInSeconds: 60, events: [{ type: 2, timestamp: 1000, data: {} }] }) }, async () => {}).evaluate({ id: "browser", type: "browser", weight: 100, enabled: true, prerequisites: [], config: { actions: [{ type: "goto", url: "https://app.test" }] } }, context, new AbortController().signal);
  expect(outcome.evidence.map(e => e.role)).toContain("browser-replay");
  expect(saved).toContainEqual(expect.objectContaining({ role: "browser-replay", value: [{ type: 2, timestamp: 1000, data: {} }] }));
});

test("retains screenshot and assertion evidence when replay retrieval fails", async () => {
  const saved: unknown[] = [];
  const store = async (input: unknown) => { saved.push(input); return { digest: "a".repeat(64), role: (input as { role: string }).role }; };
  const page = { goto: async () => {}, textContent: async () => "ready", url: () => "https://app.test", screenshot: async () => new Uint8Array([1, 2]) };
  const context = { resources: { acquireBrowser: async () => ({ id: "b", newPage: async () => page }), releaseBrowser: async () => {} }, evidence: { putBytes: store, putJson: store }, remainingMs: () => 60000 } as unknown as EvaluatorContext;
  const outcome = await new BrowserEvaluator({ getReplayUrl: async () => { throw new Error("404"); } }, async () => {}).evaluate({ id: "browser", type: "browser", enabled: true, weight: 100, prerequisites: [], config: { actions: [{ type: "assertText", selector: "main", contains: "ready" }, { type: "screenshot", role: "result" }] } }, context, new AbortController().signal);
  expect(outcome.status).toBe("error");
  expect(outcome.assertions[0].passed).toBe(true);
  expect(outcome.evidence.map(item => item.role)).toEqual(["result", "browser-assertions"]);
  expect(outcome.metadata.replayAvailable).toBe(false);
});

test.each([true, false])("follows the generated short link and grades its actual redirect: %s", async (correct) => {
  let current = "https://app.test/?pt_token=secret";
  const page = { goto: async (url: string) => { current = new URL(url).pathname === "/s/abc" ? (correct ? "https://example.com/agentbench" : "https://example.com/wrong") : url; }, textContent: async () => "https://app.test/s/abc", url: () => current };
  const context = { resources: { acquireBrowser: async () => ({ id: "b", newPage: async () => page }), releaseBrowser: async () => undefined }, remainingMs: () => 60000 } as unknown as EvaluatorContext;
  const outcome = await new BrowserEvaluator({ getReplayUrl: async () => ({ url: "https://replay.test", expiresInSeconds: 60 }) }, async () => {}).evaluate({ id: "redirect", type: "browser", enabled: true, weight: 100, prerequisites: [], config: { actions: [{ type: "followTextLink", selector: "#short-url" }, { type: "assertUrl", matches: "^https://example\\.com/agentbench$" }] } }, context, new AbortController().signal);
  expect(outcome.status).toBe(correct ? "passed" : "failed");
  expect(outcome.assertions.at(-1)?.observed).toBe(correct ? "https://example.com/agentbench" : "https://example.com/wrong");
});

test("releases the recorded browser and polls until replay evidence is ready", async () => {
  const page = { goto: vi.fn(), fill: vi.fn(), click: vi.fn(), textContent: vi.fn(async () => "Welcome Aditya"), waitForUrl: vi.fn(), url: vi.fn(() => "https://app.test/done"), screenshot: vi.fn(async () => new Uint8Array([1, 2])) };
  const browser = { id: "browser-1", newPage: vi.fn(async () => page), close: vi.fn() };
  const putBytes = vi.fn(async (input) => ({ ...input, digest: "b".repeat(64), size: 2, runId: "r", taskId: "t", createdAt: "now", redacted: true }));
  const lifecycle: string[] = [];
  const releaseBrowser = vi.fn(async () => { lifecycle.push("release"); });
  const context = { resources: { acquireBrowser: vi.fn(async () => browser), releaseBrowser, getOutput: () => "https://app.test" }, evidence: { putBytes }, remainingMs: () => 60_000 } as unknown as EvaluatorContext;
  const getReplayUrl = vi.fn()
    .mockRejectedValueOnce(new Error("No replay available"))
    .mockResolvedValueOnce({ url: "https://replay.test", expiresInSeconds: 60 });
  const outcome = await new BrowserEvaluator({ getReplayUrl }, async (ms) => { lifecycle.push(`wait:${ms}`); }).evaluate({ id: "browser", type: "browser", weight: 100, enabled: true, prerequisites: ["serve"], config: { actions: [
    { type: "goto", url: { fromEvaluator: "serve", output: "previewUrl" } }, { type: "fill", selector: "#name", value: "Aditya" }, { type: "click", selector: "button" },
    { type: "assertText", selector: "main", contains: "Aditya" }, { type: "assertUrl", matches: "/done$" }, { type: "screenshot", role: "result" },
  ] } }, context, new AbortController().signal);
  expect(context.resources.acquireBrowser).toHaveBeenCalledWith("evaluator:browser", { recording: true });
  expect(releaseBrowser).toHaveBeenCalledWith("browser-1");
  expect(lifecycle.slice(0, 2)).toEqual(["wait:2000", "release"]);
  expect(getReplayUrl).toHaveBeenCalledTimes(2);
  expect(outcome).toMatchObject({ status: "passed", metadata: { replayUrl: "https://replay.test" } });
  expect(outcome.assertions).toHaveLength(2);
  expect(outcome.evidence[0].external?.url).toBe("https://replay.test");
});

test("resolves expected text from a prerequisite evaluator output", async () => {
  const page = { goto: vi.fn(), fill: vi.fn(), click: vi.fn(), textContent: vi.fn(async () => "Current term: 3"), waitForUrl: vi.fn(), url: vi.fn(() => "https://app.test"), screenshot: vi.fn() };
  const browser = { id: "browser-1", newPage: vi.fn(async () => page), close: vi.fn() };
  const context = {
    resources: {
      acquireBrowser: vi.fn(async () => browser),
      releaseBrowser: vi.fn(async () => undefined),
      getOutput: (_evaluatorId: string, key: string) => key === "previewUrl" ? "https://app.test" : "3",
    },
    evidence: { putBytes: vi.fn() },
    remainingMs: () => 60_000,
  } as unknown as EvaluatorContext;
  const outcome = await new BrowserEvaluator({ getReplayUrl: vi.fn(async () => ({ url: "https://replay.test", expiresInSeconds: 60 })) }).evaluate({
    id: "browser",
    type: "browser",
    weight: 100,
    enabled: true,
    prerequisites: ["verify"],
    config: { actions: [
      { type: "goto", url: { fromEvaluator: "verify", output: "previewUrl" } },
      { type: "assertText", selector: "[data-term]", contains: { fromEvaluator: "verify", output: "expectedTerm" } },
    ] },
  }, context, new AbortController().signal);

  expect(outcome.assertions[0]).toMatchObject({ passed: true, expected: "3" });
});
