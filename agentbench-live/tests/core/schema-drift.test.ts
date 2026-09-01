import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { runPlanOutputJsonSchema } from "@/core/domain/plan";

test("checked-in planner schema matches RunPlanSchema", () => {
  const checkedIn = JSON.parse(
    readFileSync(resolve("schemas/run-plan.schema.json"), "utf8"),
  );
  expect(checkedIn).toEqual(runPlanOutputJsonSchema());
});

test("planner schema satisfies strict structured-output object rules", () => {
  const checkedIn = JSON.parse(
    readFileSync(resolve("schemas/run-plan.schema.json"), "utf8"),
  ) as {
    properties: {
      reason: {
        properties: Record<string, { anyOf?: Array<{ type?: string }> }>;
        required?: string[];
      };
    };
  };

  const reason = checkedIn.properties.reason;
  expect(reason.required).toEqual(["browser", "sandbox", "desktop"]);
  for (const property of Object.values(reason.properties)) {
    expect(property.anyOf).toContainEqual({ type: "null" });
  }
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
