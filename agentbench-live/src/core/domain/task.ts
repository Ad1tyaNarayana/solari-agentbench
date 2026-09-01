import type { Primitive } from "./plan";

export type ResourceBudget = {
  totalMs: number;
  browserMs: number;
  sandboxMs: number;
  desktopMs: number;
};

export type TaskManifest = {
  id: string;
  version: string;
  title: string;
  prompt: string;
  allowedPrimitives: Primitive[];
  requiredEvidence: Primitive[];
  budget: ResourceBudget;
  verifier: string;
};
