import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runPlanOutputJsonSchema } from "../src/core/domain/plan";

const destination = resolve("schemas/run-plan.schema.json");
const output = `${JSON.stringify(
  runPlanOutputJsonSchema(),
  null,
  2,
)}\n`;

mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, output);
