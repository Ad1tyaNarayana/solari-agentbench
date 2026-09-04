import { z } from "zod";
import type { TaskManifest } from "./task";

export const PrimitiveSchema = z.enum(["browser", "sandbox", "desktop"]);
export type Primitive = z.infer<typeof PrimitiveSchema>;

export const RunPlanSchema = z
  .object({
    primitives: z
      .array(PrimitiveSchema)
      .min(1)
      .superRefine((items, ctx) => {
        if (new Set(items).size !== items.length) {
          ctx.addIssue({ code: "custom", message: "primitives must be unique" });
        }
      }),
    reason: z.object({
      browser: z.string().min(3).nullable().optional(),
      sandbox: z.string().min(3).nullable().optional(),
      desktop: z.string().min(3).nullable().optional(),
    }).strict(),
    verificationStrategy: z.string().min(3),
  }).strict()
  .superRefine((plan, ctx) => {
    for (const primitive of plan.primitives) {
      if (!plan.reason[primitive]) {
        ctx.addIssue({
          code: "custom",
          message: `${primitive} requires a reason`,
        });
      }
    }
  });

export type RunPlan = z.infer<typeof RunPlanSchema>;

export function runPlanOutputJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(RunPlanSchema, {
    target: "draft-7",
  }) as Record<string, unknown> & {
    properties?: {
      reason?: {
        properties?: Record<string, unknown>;
        required?: string[];
      };
    };
  };
  const reason = schema.properties?.reason;
  if (!reason?.properties) {
    throw new Error("RunPlan reason schema is missing");
  }
  reason.required = Object.keys(reason.properties);
  return schema;
}

export function validatePlanForTask(
  plan: RunPlan,
  task: Pick<TaskManifest, "id" | "allowedPrimitives">,
): RunPlan {
  const forbidden = plan.primitives.find(
    (item) => !task.allowedPrimitives.includes(item),
  );
  if (forbidden) {
    throw new Error(`${forbidden} is not allowed for task ${task.id}`);
  }
  return plan;
}
