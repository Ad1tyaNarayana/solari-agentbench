import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { RunPlanSchema } from "../src/core/domain/plan";

const destination = resolve("schemas/run-plan.schema.json");
const output = `${JSON.stringify(
  z.toJSONSchema(RunPlanSchema, { target: "draft-7" }),
  null,
  2,
)}\n`;

mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, output);
