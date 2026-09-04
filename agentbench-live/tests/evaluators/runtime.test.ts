import { EvaluatorRuntime } from "@/core/evaluators/runtime";

test("owns resources and exposes completed prerequisite outputs until idempotent cleanup", async () => {
  const sandbox = { id: "s1", kill: vi.fn(async () => undefined) };
  const browser = { id: "b1", close: vi.fn(async () => undefined) };
  const services = { sandbox: { create: vi.fn(async () => sandbox) }, browser: { create: vi.fn(async () => browser) }, desktop: { create: vi.fn() } };
  const runtime = new EvaluatorRuntime(services as never);
  expect(await runtime.acquireSandbox("command")).toBe(sandbox);
  expect(await runtime.acquireBrowser("browser", { recording: true })).toBe(browser);
  runtime.publishOutputs("serve", { previewUrl: "https://preview" });
  expect(runtime.getOutput("serve", "previewUrl")).toBe("https://preview");
  await runtime.dispose();
  await runtime.dispose();
  expect(sandbox.kill).toHaveBeenCalledOnce();
  expect(browser.close).toHaveBeenCalledOnce();
});
