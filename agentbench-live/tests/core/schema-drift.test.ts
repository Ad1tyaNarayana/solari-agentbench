import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { RunPlanSchema } from "@/core/domain/plan";

test("checked-in planner schema matches RunPlanSchema", () => {
  const checkedIn = JSON.parse(
    readFileSync(resolve("schemas/run-plan.schema.json"), "utf8"),
  );
  expect(checkedIn).toEqual(z.toJSONSchema(RunPlanSchema, { target: "draft-7" }));
});

test("planner schema constrains primitive selection", () => {
  const checkedIn = JSON.parse(
    readFileSync(resolve("schemas/run-plan.schema.json"), "utf8"),
  );
  expect(checkedIn).toMatchObject({
    type: "object",
    properties: {
      primitives: {
        type: "array",
        items: { enum: ["browser", "sandbox", "desktop"] },
      },
    },
    required: ["primitives", "reason", "verificationStrategy"],
  });
});
