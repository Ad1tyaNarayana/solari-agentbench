import { BrowserEvaluator } from "@/core/evaluators/browser";
import type { EvaluatorContext } from "@/core/evaluators/types";

test("runs the recorded action DSL and retains screenshot and replay evidence", async () => {
  const page = { goto: vi.fn(), fill: vi.fn(), click: vi.fn(), textContent: vi.fn(async () => "Welcome Aditya"), waitForUrl: vi.fn(), url: vi.fn(() => "https://app.test/done"), screenshot: vi.fn(async () => new Uint8Array([1, 2])) };
  const browser = { id: "browser-1", newPage: vi.fn(async () => page), close: vi.fn() };
  const putBytes = vi.fn(async (input) => ({ ...input, digest: "b".repeat(64), size: 2, runId: "r", taskId: "t", createdAt: "now", redacted: true }));
  const context = { resources: { acquireBrowser: vi.fn(async () => browser), getOutput: () => "https://app.test" }, evidence: { putBytes } } as unknown as EvaluatorContext;
  const outcome = await new BrowserEvaluator({ getReplayUrl: vi.fn(async () => ({ url: "https://replay.test", expiresInSeconds: 60 })) }).evaluate({ id: "browser", type: "browser", weight: 100, enabled: true, prerequisites: ["serve"], config: { actions: [
    { type: "goto", url: { fromEvaluator: "serve", output: "previewUrl" } }, { type: "fill", selector: "#name", value: "Aditya" }, { type: "click", selector: "button" },
    { type: "assertText", selector: "main", contains: "Aditya" }, { type: "assertUrl", matches: "/done$" }, { type: "screenshot", role: "result" },
  ] } }, context, new AbortController().signal);
  expect(context.resources.acquireBrowser).toHaveBeenCalledWith("evaluator:browser", { recording: true });
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
      getOutput: (_evaluatorId: string, key: string) => key === "previewUrl" ? "https://app.test" : "3",
    },
    evidence: { putBytes: vi.fn() },
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
