import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Primitive } from "@/core/domain/plan";
import type {
  AgentDefinition,
  BenchmarkDiagnostic,
  BenchmarkFileManifest,
  BenchmarkTaskDefinition,
  EvaluationPolicy,
  EvaluatorDefinition,
} from "./types";
import { BenchmarkValidationError, DEFAULT_EVALUATION_POLICY } from "./types";

const primitiveSchema = z.enum(["browser", "sandbox", "desktop"]);
const evaluatorTypeSchema = z.enum([
  "file",
  "schema",
  "command",
  "http",
  "browser",
  "numeric",
  "model-judge",
]);
const unknownRecordSchema = z.record(z.string(), z.unknown());

const safePathSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    const normalized = value.replaceAll("\\", "/");
    return (
      !normalized.startsWith("/") &&
      !/^[A-Za-z]:\//.test(normalized) &&
      !normalized.split("/").includes("..")
    );
  }, "path must be a safe relative path");

const evaluatorSchema = z
  .object({
    id: z.string().min(1),
    type: evaluatorTypeSchema,
    weight: z.number().min(0),
    enabled: z.boolean().default(true),
    prerequisites: z.array(z.string()).default([]),
    config: unknownRecordSchema.default({}),
  })
  .strict();

const resourceBudgetSchema = z
  .object({
    browserSessions: z.number().int().min(0),
    sandboxes: z.number().int().min(0),
    desktops: z.number().int().min(0),
    totalMinutes: z.number().int().min(0),
  })
  .strict();

const resourcesSchema = z
  .object({
    allowed: z.array(primitiveSchema),
    planningRequired: z.boolean(),
    budget: resourceBudgetSchema,
  })
  .strict();

const submissionSchema = z
  .object({
    directory: safePathSchema,
    required: z.array(safePathSchema),
  })
  .strict();

const legacyBudgetSchema = z
  .object({
    totalMs: z.number().int().min(0),
    browserMs: z.number().int().min(0),
    sandboxMs: z.number().int().min(0),
    desktopMs: z.number().int().min(0),
  })
  .strict();

const compatibilitySchema = z
  .object({
    requiredEvidence: z.array(primitiveSchema),
    legacyVerifier: z.string(),
    legacyBudgetMs: legacyBudgetSchema,
  })
  .strict();

const evaluationPolicySchema = z
  .object({
    maxModelJudgeWeight: z.number().min(0).max(100),
    allowModelJudgeMajority: z.boolean(),
  })
  .strict();
const taskSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    name: z.string().min(1),
    prompt: safePathSchema,
    fixtures: z.array(safePathSchema),
    resources: resourcesSchema,
    submission: submissionSchema,
    compatibility: compatibilitySchema.optional(),
    evaluationPolicy: evaluationPolicySchema.default(DEFAULT_EVALUATION_POLICY),
    evaluators: z.array(evaluatorSchema).min(1),
  })
  .strict();

const harnessSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
  })
  .strict();

const agentSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    credential: z.string().optional(),
    harness: harnessSchema,
    options: unknownRecordSchema.default({}),
  })
  .strict();

const benchmarkDefaultsSchema = z
  .object({
    timeoutSeconds: z.number().int().min(0),
    maxConcurrency: z.number().int().min(1),
    submissionDirectory: safePathSchema,
  })
  .strict();

export const TaskFileSchema = taskSchema;

export const AgentsFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    agents: z.array(agentSchema),
  })
  .strict();

export const BenchmarkFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().optional(),
    taskRoots: z.array(safePathSchema).min(1),
    defaults: benchmarkDefaultsSchema,
  })
  .strict();

function diagnostics(error: z.ZodError): BenchmarkDiagnostic[] {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "$",
    code: issue.code,
    message: issue.message,
  }));
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  let value: unknown = input;

  try {
    value = typeof input === "string" ? parseYaml(input) : input;
  } catch (error) {
    throw new BenchmarkValidationError([
      {
        path: "$",
        code: "yaml_parse",
        message: error instanceof Error ? error.message : "invalid YAML",
      },
    ]);
  }

  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BenchmarkValidationError(diagnostics(result.error));
  }
  return result.data;
}

function validateEvaluatorIds(
  items: EvaluatorDefinition[],
): Map<string, EvaluatorDefinition> {
  const evaluatorsById = new Map<string, EvaluatorDefinition>();

  for (const item of items) {
    if (evaluatorsById.has(item.id)) {
      throw new BenchmarkValidationError([
        {
          path: "evaluators",
          code: "duplicate_id",
          message: `duplicate evaluator id ${item.id}`,
        },
      ]);
    }
    evaluatorsById.set(item.id, item);

    if (new Set(item.prerequisites).size !== item.prerequisites.length) {
      throw new BenchmarkValidationError([
        {
          path: `evaluators.${item.id}.prerequisites`,
          code: "duplicate_prerequisite",
          message: "prerequisites must be unique",
        },
      ]);
    }
  }

  return evaluatorsById;
}

function validateEvaluatorWeights(items: EvaluatorDefinition[]): void {
  const enabledWeight = items
    .filter((evaluator) => evaluator.enabled)
    .reduce((sum, evaluator) => sum + evaluator.weight, 0);

  if (enabledWeight !== 100) {
    throw new BenchmarkValidationError([
      {
        path: "evaluators",
        code: "weight_total",
        message: "enabled evaluator weights must total 100",
      },
    ]);
  }
}

function validateModelJudgeAuthority(
  items: EvaluatorDefinition[],
  policy: EvaluationPolicy,
): void {
  const weight = items
    .filter((evaluator) => evaluator.enabled && evaluator.type === "model-judge")
    .reduce((sum, evaluator) => sum + evaluator.weight, 0);

  if (weight > policy.maxModelJudgeWeight) {
    throw new BenchmarkValidationError([
      {
        path: "evaluationPolicy.maxModelJudgeWeight",
        code: "model_judge_authority",
        message: `enabled model-judge weight ${weight} exceeds the allowed ${policy.maxModelJudgeWeight}`,
      },
    ]);
  }
  if (weight > 50 && !policy.allowModelJudgeMajority) {
    throw new BenchmarkValidationError([
      {
        path: "evaluationPolicy.allowModelJudgeMajority",
        code: "model_judge_majority",
        message: "model-judge majority requires explicit opt-in",
      },
    ]);
  }
}
function validateEvaluatorReferences(
  items: EvaluatorDefinition[],
  evaluatorsById: ReadonlyMap<string, EvaluatorDefinition>,
): void {
  for (const item of items) {
    for (const prerequisite of item.prerequisites) {
      if (!evaluatorsById.has(prerequisite)) {
        throw new BenchmarkValidationError([
          {
            path: `evaluators.${item.id}.prerequisites`,
            code: "unknown_prerequisite",
            message: `unknown prerequisite ${prerequisite}`,
          },
        ]);
      }
    }
  }
}

function validateEvaluatorGraph(
  items: EvaluatorDefinition[],
  evaluatorsById: ReadonlyMap<string, EvaluatorDefinition>,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const hasCycle = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;

    visiting.add(id);
    const evaluator = evaluatorsById.get(id)!;
    for (const prerequisite of evaluator.prerequisites) {
      if (hasCycle(prerequisite)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  if (items.some((evaluator) => hasCycle(evaluator.id))) {
    throw new BenchmarkValidationError([
      {
        path: "evaluators",
        code: "cycle",
        message: "evaluator prerequisites must be acyclic",
      },
    ]);
  }
}

function validateEvaluators(items: EvaluatorDefinition[]): void {
  const evaluatorsById = validateEvaluatorIds(items);
  validateEvaluatorWeights(items);
  validateEvaluatorReferences(items, evaluatorsById);
  validateEvaluatorGraph(items, evaluatorsById);
}

function taskResult(raw: z.infer<typeof taskSchema>): BenchmarkTaskDefinition {
  validateEvaluators(raw.evaluators as EvaluatorDefinition[]);
  validateModelJudgeAuthority(
    raw.evaluators as EvaluatorDefinition[],
    raw.evaluationPolicy,
  );
  return {
    id: raw.id,
    name: raw.name,
    promptPath: raw.prompt,
    prompt: raw.prompt,
    fixtures: raw.fixtures,
    allowedPrimitives: raw.resources.allowed as Primitive[],
    planningRequired: raw.resources.planningRequired,
    resourceLimits: raw.resources.budget,
    submission: raw.submission,
    compatibility: raw.compatibility,
    evaluationPolicy: { ...raw.evaluationPolicy },
    evaluators: raw.evaluators as EvaluatorDefinition[],
  };
}

export function parseTaskFile(input: unknown): BenchmarkTaskDefinition {
  return taskResult(parse(taskSchema, input));
}

export function parseAgentsFile(input: unknown): AgentDefinition[] {
  const value = parse(AgentsFileSchema, input);
  const ids = value.agents.map((agent) => agent.id);
  if (new Set(ids).size !== ids.length) {
    throw new BenchmarkValidationError([
      {
        path: "agents",
        code: "duplicate_id",
        message: "agent IDs must be unique",
      },
    ]);
  }
  return value.agents as AgentDefinition[];
}

export function parseBenchmarkFile(input: unknown): BenchmarkFileManifest {
  return parse(BenchmarkFileSchema, input);
}

export { BenchmarkValidationError } from "./types";
