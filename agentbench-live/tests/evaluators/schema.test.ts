import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SchemaEvaluator } from "@/core/evaluators/schema";
import type { EvaluatorContext } from "@/core/evaluators/types";

async function fixture(contents: string, schema: unknown, references: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "agentbench-schema-"));
  await mkdir(join(root, "schemas"));
  await writeFile(join(root, "schemas", "result.json"), JSON.stringify(schema));
  for (const [name, value] of Object.entries(references)) await writeFile(join(root, "schemas", name), JSON.stringify(value));
  return { submission: { digest: "x", entries: { "result.yaml": { kind: "text", contents } } }, snapshot: { root, digest: "s", files: ["schemas/result.json", ...Object.keys(references).map((name) => `schemas/${name}`)].map((path) => ({ path, digest: "d", size: 1 })) } } as unknown as EvaluatorContext;
}

test("validates YAML with strict JSON Schema diagnostics", async () => {
  const context = await fixture("name: demo\nextra: nope", { type: "object", required: ["name", "count"], additionalProperties: false, properties: { name: { type: "string" }, count: { type: "number" } } });
  const outcome = await new SchemaEvaluator().evaluate({ id: "s", type: "schema", weight: 100, enabled: true, prerequisites: [], config: { subject: "result.yaml", schema: "schemas/result.json" } }, context, new AbortController().signal);
  expect(outcome.status).toBe("failed");
  expect(outcome.assertions.map((item) => item.summary).join(" ")).toMatch(/required|additional/i);
});

test("resolves local references only from the immutable snapshot", async () => {
  const context = await fixture("name: demo", { $ref: "defs.json" }, { "defs.json": { type: "object", required: ["name"], properties: { name: { type: "string" } } } });
  const outcome = await new SchemaEvaluator().evaluate({ id: "s", type: "schema", weight: 100, enabled: true, prerequisites: [], config: { subject: "result.yaml", schema: "schemas/result.json" } }, context, new AbortController().signal);
  expect(outcome.status).toBe("passed");
});

test("rejects remote and absolute schema references", async () => {
  for (const ref of ["https://example.com/schema.json", "C:/schema.json"]) {
    const context = await fixture("name: demo", { $ref: ref });
    await expect(new SchemaEvaluator().evaluate({ id: "s", type: "schema", weight: 100, enabled: true, prerequisites: [], config: { subject: "result.yaml", schema: "schemas/result.json" } }, context, new AbortController().signal)).rejects.toThrow(/ref/i);
  }
});
