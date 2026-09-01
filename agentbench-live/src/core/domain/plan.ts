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
      browser: z.string().min(3).optional(),
      sandbox: z.string().min(3).optional(),
      desktop: z.string().min(3).optional(),
    }),
    verificationStrategy: z.string().min(3),
  })
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

export function validatePlanForTask(
  plan: RunPlan,
  task: TaskManifest,
): RunPlan {
  const forbidden = plan.primitives.find(
    (item) => !task.allowedPrimitives.includes(item),
  );
  if (forbidden) {
    throw new Error(`${forbidden} is not allowed for task ${task.id}`);
  }
  return plan;
}
