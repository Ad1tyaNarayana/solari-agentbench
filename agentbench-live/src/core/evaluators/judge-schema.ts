import { z } from "zod";

export const JudgeOutputSchema = z.object({
  score: z.number().min(0).max(1),
  summary: z.string().min(1).max(4_000),
  criteria: z.array(z.object({ id: z.string().min(1), score: z.number().min(0).max(1), rationale: z.string().min(1).max(2_000) }).strict()).max(100),
}).strict();

export const judgeOutputJsonSchema = {
  type: "object", additionalProperties: false, required: ["score", "summary", "criteria"],
  properties: {
    score: { type: "number", minimum: 0, maximum: 1 }, summary: { type: "string", minLength: 1, maxLength: 4000 },
    criteria: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: false, required: ["id", "score", "rationale"], properties: { id: { type: "string", minLength: 1 }, score: { type: "number", minimum: 0, maximum: 1 }, rationale: { type: "string", minLength: 1, maxLength: 2000 } } } },
  },
} as const;
