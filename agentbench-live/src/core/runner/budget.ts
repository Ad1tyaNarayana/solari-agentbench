import type { ResourceBudget } from "@/core/domain/task";

export type MatrixItem = { budget: ResourceBudget };

export type ResourceEstimate = ResourceBudget & { jobs: number };

export function estimateResources(items: MatrixItem[]): ResourceEstimate {
  return items.reduce<ResourceEstimate>(
    (estimate, item) => ({
      jobs: estimate.jobs + 1,
      totalMs: estimate.totalMs + item.budget.totalMs,
      browserMs: estimate.browserMs + item.budget.browserMs,
      sandboxMs: estimate.sandboxMs + item.budget.sandboxMs,
      desktopMs: estimate.desktopMs + item.budget.desktopMs,
    }),
    { jobs: 0, totalMs: 0, browserMs: 0, sandboxMs: 0, desktopMs: 0 },
  );
}
