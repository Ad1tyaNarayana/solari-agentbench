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
  z.object({ type: z.literal("assertText"), selector: z.string(), contains: z.string() }).strict(),
  z.object({ type: z.literal("assertUrl"), matches: z.string() }).strict(),
  z.object({ type: z.literal("screenshot"), role: z.string().default("screenshot") }).strict(),
]);
const Config = z.object({ actions: z.array(Action).min(1).max(500) }).strict();

export class BrowserEvaluator implements Evaluator {
  readonly type = "browser" as const;
  constructor(private readonly browserService: Pick<BrowserService, "getReplayUrl">) {}
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
      else if (action.type === "assertText") { const observed = await page.textContent(action.selector); assertions.push({ id: `${definition.id}.${index + 1}`, passed: observed?.includes(action.contains) ?? false, summary: `Text at ${action.selector} contains expected value`, expected: action.contains, observed }); }
      else if (action.type === "assertUrl") { const observed = page.url(); assertions.push({ id: `${definition.id}.${index + 1}`, passed: new RegExp(action.matches).test(observed), summary: "Current URL matches", expected: action.matches, observed }); }
      else evidence.push(await context.evidence.putBytes({ evaluatorId: definition.id, mimeType: "image/png", role: action.role, producer: "evaluator", bytes: await page.screenshot() }));
    }
    const replay = await this.browserService.getReplayUrl(browser.id);
    const external = { url: replay.url, expiresAt: new Date(Date.now() + replay.expiresInSeconds * 1_000).toISOString() };
    if (evidence[0]) evidence[0] = { ...evidence[0], external };
    const passedCount = assertions.filter((item) => item.passed).length;
    const passed = passedCount === assertions.length;
    return { status: passed ? "passed" : "failed", earnedFraction: assertions.length ? passedCount / assertions.length : 1, summary: assertions.length ? `${passedCount}/${assertions.length} browser assertions passed` : "Browser actions completed", assertions, evidence, outputs: { finalUrl: page.url() }, metadata: { replayUrl: replay.url, replayExpiresAt: external.expiresAt, recording: true } };
  }
}
