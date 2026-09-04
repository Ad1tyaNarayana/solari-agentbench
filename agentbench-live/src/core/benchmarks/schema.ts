import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Primitive } from "@/core/domain/plan";
import type { AgentDefinition, BenchmarkDefinition, BenchmarkDiagnostic, BenchmarkFileManifest, BenchmarkTaskDefinition, EvaluatorDefinition } from "./types";
import { BenchmarkValidationError } from "./types";

const primitives = z.enum(["browser", "sandbox", "desktop"]);
const evaluatorTypes = z.enum(["file", "schema", "command", "http", "browser", "numeric", "model-judge"]);
const unknownRecord = z.record(z.string(), z.unknown());
const safePath = z.string().trim().min(1).refine((value) => {
  const normalized = value.replaceAll("\\", "/");
  return !normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized) && !normalized.split("/").includes("..");
}, "path must be a safe relative path");
const evaluator = z.object({
  id: z.string().min(1), type: evaluatorTypes, weight: z.number().min(0), enabled: z.boolean().default(true),
  prerequisites: z.array(z.string()).default([]), config: unknownRecord.default({}),
}).strict();
const task = z.object({
  schemaVersion: z.literal(1), id: z.string().min(1), name: z.string().min(1), prompt: safePath,
  fixtures: z.array(safePath),
  resources: z.object({ allowed: z.array(primitives), planningRequired: z.boolean(), budget: z.object({
    browserSessions: z.number().int().min(0), sandboxes: z.number().int().min(0), desktops: z.number().int().min(0), totalMinutes: z.number().int().min(0),
  }).strict() }).strict(),
  submission: z.object({ directory: safePath, required: z.array(safePath) }).strict(),
  compatibility: z.object({ requiredEvidence: z.array(primitives), legacyVerifier: z.string(), legacyBudgetMs: z.object({ totalMs: z.number().int().min(0), browserMs: z.number().int().min(0), sandboxMs: z.number().int().min(0), desktopMs: z.number().int().min(0) }).strict() }).strict().optional(),
  evaluators: z.array(evaluator).min(1),
}).strict();
const agent = z.object({ schemaVersion: z.literal(1), id: z.string().min(1), name: z.string().min(1), provider: z.string().min(1), model: z.string().optional(), reasoningEffort: z.string().optional(), credential: z.string().optional(), harness: z.object({ id: z.string().min(1), version: z.string().min(1) }).strict(), options: unknownRecord.default({}) }).strict();
export const TaskFileSchema = task;
export const AgentsFileSchema = z.object({ schemaVersion: z.literal(1), agents: z.array(agent) }).strict();
export const BenchmarkFileSchema = z.object({ schemaVersion: z.literal(1), id: z.string().min(1), name: z.string().min(1), version: z.string().min(1), description: z.string().optional(), taskRoots: z.array(safePath).min(1), defaults: z.object({ timeoutSeconds: z.number().int().min(0), maxConcurrency: z.number().int().min(1), submissionDirectory: safePath }).strict() }).strict();

function diagnostics(error: z.ZodError): BenchmarkDiagnostic[] {
  return error.issues.map((i) => ({ path: i.path.join(".") || "$", code: i.code, message: i.message }));
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  let value: unknown = input;
  try { value = typeof input === "string" ? parseYaml(input) : input; } catch (error) { throw new BenchmarkValidationError([{ path: "$", code: "yaml_parse", message: error instanceof Error ? error.message : "invalid YAML" }]); }
  const result = schema.safeParse(value);
  if (!result.success) throw new BenchmarkValidationError(diagnostics(result.error));
  return result.data;
}
function validateEvaluators(items: EvaluatorDefinition[]): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new BenchmarkValidationError([{ path: "evaluators", code: "duplicate_id", message: `duplicate evaluator id ${item.id}` }]);
    ids.add(item.id);
    if (new Set(item.prerequisites).size !== item.prerequisites.length) throw new BenchmarkValidationError([{ path: `evaluators.${item.id}.prerequisites`, code: "duplicate_prerequisite", message: "prerequisites must be unique" }]);
  }
  const enabled = items.filter((e) => e.enabled);
  if (enabled.reduce((sum, e) => sum + e.weight, 0) !== 100) throw new BenchmarkValidationError([{ path: "evaluators", code: "weight_total", message: "enabled evaluator weights must total 100" }]);
  for (const item of items) for (const prerequisite of item.prerequisites) if (!ids.has(prerequisite)) throw new BenchmarkValidationError([{ path: `evaluators.${item.id}.prerequisites`, code: "unknown_prerequisite", message: `unknown prerequisite ${prerequisite}` }]);
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): boolean => { if (visiting.has(id)) return true; if (visited.has(id)) return false; visiting.add(id); const item = items.find((e) => e.id === id)!; for (const p of item.prerequisites) if (visit(p)) return true; visiting.delete(id); visited.add(id); return false; };
  if (items.some((e) => visit(e.id))) throw new BenchmarkValidationError([{ path: "evaluators", code: "cycle", message: "evaluator prerequisites must be acyclic" }]);
}
function taskResult(raw: z.infer<typeof task>): BenchmarkTaskDefinition {
  validateEvaluators(raw.evaluators as EvaluatorDefinition[]);
  return { id: raw.id, name: raw.name, promptPath: raw.prompt, prompt: raw.prompt, fixtures: raw.fixtures, allowedPrimitives: raw.resources.allowed as Primitive[], planningRequired: raw.resources.planningRequired, resourceLimits: raw.resources.budget, submission: raw.submission, compatibility: raw.compatibility, evaluators: raw.evaluators as EvaluatorDefinition[] };
}
export function parseTaskFile(input: unknown): BenchmarkTaskDefinition { return taskResult(parse(task, input)); }
export function parseAgentsFile(input: unknown): AgentDefinition[] { const value = parse(AgentsFileSchema, input); const ids = value.agents.map((a) => a.id); if (new Set(ids).size !== ids.length) throw new BenchmarkValidationError([{ path: "agents", code: "duplicate_id", message: "agent IDs must be unique" }]); return value.agents as AgentDefinition[]; }
export function parseBenchmarkFile(input: unknown): BenchmarkFileManifest { return parse(BenchmarkFileSchema, input); }
export { BenchmarkValidationError } from "./types";
