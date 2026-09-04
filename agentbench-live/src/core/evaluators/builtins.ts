import type { SolariServices } from "@/core/solari/contracts";
import { BrowserEvaluator } from "./browser";
import { CommandEvaluator } from "./command";
import { FileEvaluator } from "./file";
import { HttpEvaluator } from "./http";
import { ModelJudgeEvaluator } from "./model-judge";
import { NumericEvaluator } from "./numeric";
import { EvaluatorRegistry } from "./registry";
import { SchemaEvaluator } from "./schema";

export function createBuiltinEvaluatorRegistry(services: SolariServices): EvaluatorRegistry {
  const registry = new EvaluatorRegistry();
  registry.register("file", new FileEvaluator());
  registry.register("schema", new SchemaEvaluator());
  registry.register("command", new CommandEvaluator());
  registry.register("http", new HttpEvaluator());
  registry.register("browser", new BrowserEvaluator(services.browser));
  registry.register("numeric", new NumericEvaluator());
  registry.register("model-judge", new ModelJudgeEvaluator());
  return registry;
}
