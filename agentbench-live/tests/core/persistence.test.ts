import { afterEach, expect, test } from "vitest";
import { SqliteRunRepository } from "@/core/persistence/sqlite-repository";

let repository: SqliteRunRepository | undefined;

afterEach(() => repository?.close());

test("persists failed runs and their last successful stage", () => {
  repository = new SqliteRunRepository(":memory:");
  const created = repository.create({
    taskId: "url-shortener",
    agentId: "sol-low",
  });
  repository.update(created.id, {
    stage: "failed",
    failureCode: "build_failed",
    lastSuccessfulStage: "provisioning",
  });
  expect(repository.get(created.id)).toMatchObject({
    stage: "failed",
    failureCode: "build_failed",
    lastSuccessfulStage: "provisioning",
  });
});

test("round-trips structured plans, scores, and evidence", () => {
  repository = new SqliteRunRepository(":memory:");
  const created = repository.create({
    taskId: "same-stats",
    agentId: "luna-high",
  });
  repository.update(created.id, {
    runPlan: {
      primitives: ["sandbox"],
      reason: { sandbox: "recompute findings" },
      verificationStrategy: "compare statistics",
    },
    score: { total: 100 },
    evidence: { checksum: "abc123" },
  });
  expect(repository.get(created.id)).toMatchObject({
    runPlan: { primitives: ["sandbox"] },
    score: { total: 100 },
    evidence: { checksum: "abc123" },
  });
});

test("assigns monotonically increasing persisted event sequences", () => {
  repository = new SqliteRunRepository(":memory:");
  const run = repository.create({ taskId: "sample", agentId: "sol-low" });
  repository.appendEvent(run.id, { kind: "stage", payload: { stage: "planning" } });
  repository.appendEvent(run.id, { kind: "log", payload: { line: "ready" } });
  expect(repository.listEvents(run.id).map((event) => event.sequence)).toEqual([
    1, 2,
  ]);
});

test("updating a run preserves its persisted event history", () => {
  repository = new SqliteRunRepository(":memory:");
  const run = repository.create({ taskId: "sample", agentId: "sol-low" });
  repository.appendEvent(run.id, { kind: "stage", payload: { stage: "planning" } });

  repository.update(run.id, { stage: "planning" });

  expect(repository.listEvents(run.id)).toHaveLength(1);
});
