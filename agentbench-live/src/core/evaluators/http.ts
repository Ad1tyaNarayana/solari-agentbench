import { z } from "zod";
import type { EvaluatorDefinition } from "@/core/benchmarks/types";
import { jsonPointer, resolveValue } from "./value-reference";
import type { Evaluator, EvaluatorContext, EvaluatorOutcome } from "./types";

const Value = z.union([z.string(), z.object({ fromEvaluator: z.string(), output: z.string() }).strict()]);
const Assertion = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), equals: z.number().int().min(100).max(599) }).strict(),
  z.object({ type: z.literal("header"), name: z.string(), equals: z.string() }).strict(),
  z.object({ type: z.literal("json"), pointer: z.string(), equals: z.unknown() }).strict(),
  z.object({ type: z.literal("text"), contains: z.string() }).strict(),
]);
const Config = z.object({ url: Value, method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"), headers: z.record(z.string(), z.string()).default({}), body: z.string().optional(), redirect: z.enum(["follow", "error", "manual"]).default("error"), timeoutMs: z.number().int().positive().max(120_000).default(30_000), maxBytes: z.number().int().positive().max(10 * 1024 * 1024).default(10 * 1024 * 1024), assertions: z.array(Assertion).min(1) }).strict();
const allowedHeaders = new Set(["accept", "accept-language", "cache-control", "content-type", "if-none-match", "range", "user-agent"]);

export class HttpEvaluator implements Evaluator {
  readonly type = "http" as const;
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  validate(definition: EvaluatorDefinition): void { Config.parse(definition.config); }
  async evaluate(definition: EvaluatorDefinition, context: EvaluatorContext, signal: AbortSignal): Promise<EvaluatorOutcome> {
    const config = Config.parse(definition.config);
    for (const name of Object.keys(config.headers)) if (!allowedHeaders.has(name.toLowerCase())) throw new Error(`Unsafe HTTP request header: ${name}`);
    const url = resolveValue(config.url, context);
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error("HTTP evaluator URL must resolve to HTTP(S)");
    const response = await this.fetcher(url, { method: config.method, headers: config.headers, body: config.body, redirect: config.redirect, signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(config.timeoutMs, context.remainingMs?.() ?? config.timeoutMs))]), credentials: "omit" });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > config.maxBytes) throw new Error(`HTTP response exceeds ${config.maxBytes} bytes`);
    const text = new TextDecoder().decode(bytes);
    let json: unknown;
    const assertions = config.assertions.map((assertion, index) => {
      let observed: unknown;
      let passed = false;
      if (assertion.type === "status") { observed = response.status; passed = observed === assertion.equals; }
      else if (assertion.type === "header") { observed = response.headers.get(assertion.name); passed = observed === assertion.equals; }
      else if (assertion.type === "text") { observed = text; passed = text.includes(assertion.contains); }
      else { json ??= JSON.parse(text); observed = jsonPointer(json, assertion.pointer); passed = JSON.stringify(observed) === JSON.stringify(assertion.equals); }
      return { id: `${definition.id}.${index + 1}`, passed, summary: `HTTP ${assertion.type} assertion`, expected: "equals" in assertion ? assertion.equals : assertion.contains, observed };
    });
    const passedCount = assertions.filter((item) => item.passed).length;
    return { status: passedCount === assertions.length ? "passed" : "failed", earnedFraction: passedCount / assertions.length, summary: `${passedCount}/${assertions.length} HTTP assertions passed`, assertions, evidence: [], outputs: { status: response.status }, metadata: { url, method: config.method, redirect: config.redirect } };
  }
}
