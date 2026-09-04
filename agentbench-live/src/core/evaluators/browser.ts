import { z } from "zod";
import type { EvaluatorDefinition } from "@/core/benchmarks/types";
import type { BrowserService } from "@/core/solari/contracts";
import { resolveValue } from "./value-reference";
import type { Evaluator, EvaluatorContext, EvaluatorOutcome } from "./types";

const Value = z.union([z.string(), z.object({ fromEvaluator: z.string(), output: z.string() }).strict()]);
const Action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("goto"), url: Value }).strict(),
  z.object({ type: z.literal("fill"), selector: z.string(), value: z.string() }).strict(),
  z.object({ type: z.literal("click"), selector: z.string() }).strict(),
  z.object({ type: z.literal("assertText"), selector: z.string(), contains: Value }).strict(),
  z.object({ type: z.literal("assertUrl"), matches: z.string() }).strict(),
  z.object({ type: z.literal("screenshot"), role: z.string().default("screenshot") }).strict(),
]);
const Config = z.object({ actions: z.array(Action).min(1).max(500) }).strict();

export class BrowserEvaluator implements Evaluator {
  readonly type = "browser" as const;
  constructor(
    private readonly browserService: Pick<BrowserService, "getReplayUrl">,
    private readonly sleep: (milliseconds: number) => Promise<void> =
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}
  validate(definition: EvaluatorDefinition): void { Config.parse(definition.config); }
  async evaluate(definition: EvaluatorDefinition, context: EvaluatorContext, signal: AbortSignal): Promise<EvaluatorOutcome> {
    void signal;
    const config = Config.parse(definition.config);
    const browser = await context.resources.acquireBrowser(`evaluator:${definition.id}`, { recording: true });
    const page = await browser.newPage();
    const assertions = [];
    const evidence = [];
    for (const [index, action] of config.actions.entries()) {
      if (action.type === "goto") { const url = resolveValue(action.url, context); if (typeof url !== "string") throw new Error("Browser URL did not resolve to a string"); await page.goto(url); }
      else if (action.type === "fill") await page.fill(action.selector, action.value);
      else if (action.type === "click") await page.click(action.selector);
      else if (action.type === "assertText") { const expected = resolveValue(action.contains, context); if (typeof expected !== "string") throw new Error("Browser expected text did not resolve to a string"); const observed = await page.textContent(action.selector); assertions.push({ id: `${definition.id}.${index + 1}`, passed: observed?.includes(expected) ?? false, summary: `Text at ${action.selector} contains expected value`, expected, observed }); }
      else if (action.type === "assertUrl") { const observed = page.url(); assertions.push({ id: `${definition.id}.${index + 1}`, passed: new RegExp(action.matches).test(observed), summary: "Current URL matches", expected: action.matches, observed }); }
      else evidence.push(await context.evidence.putBytes({ evaluatorId: definition.id, mimeType: "image/png", role: action.role, producer: "evaluator", bytes: await page.screenshot() }));
    }
    const finalUrl = page.url();
    await this.sleep(Math.min(2_000, Math.max(0, context.remainingMs())));
    await context.resources.releaseBrowser(browser.id);
    const replay = await this.pollReplay(browser.id, context.remainingMs);
    const external = { url: replay.url, expiresAt: new Date(Date.now() + replay.expiresInSeconds * 1_000).toISOString() };
    if (evidence[0]) evidence[0] = { ...evidence[0], external };
    const passedCount = assertions.filter((item) => item.passed).length;
    const passed = passedCount === assertions.length;
    return { status: passed ? "passed" : "failed", earnedFraction: assertions.length ? passedCount / assertions.length : 1, summary: assertions.length ? `${passedCount}/${assertions.length} browser assertions passed` : "Browser actions completed", assertions, evidence, outputs: { finalUrl }, metadata: { replayUrl: replay.url, replayExpiresAt: external.expiresAt, recording: true } };
  }

  private async pollReplay(
    browserId: string,
    remainingMs: () => number,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        return await this.browserService.getReplayUrl(browserId);
      } catch {
        if (attempt === 9 || remainingMs() <= 0) break;
        await this.sleep(Math.min(3_000, Math.max(1, remainingMs())));
      }
    }
    throw new Error(
      "Browser replay unavailable after release and bounded polling",
    );
  }
}
