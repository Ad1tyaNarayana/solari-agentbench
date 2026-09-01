import { expect, test } from "vitest";
import { RunEventBus } from "@/core/events/run-events";
import { SqliteRunRepository } from "@/core/persistence/sqlite-repository";
import {
  getOrCreateGlobalServerContainer,
  persistDetachedQueueFailure,
  reconcileAbandonedRuns,
} from "@/server/recovery";

test("reconciles queued and running records left by a previous process", () => {
  const repository = new SqliteRunRepository(":memory:");
  const queued = repository.create({ taskId: "sample", agentId: "sol-low" });
  const running = repository.create({ taskId: "sample", agentId: "sol-low" });
  const completed = repository.create({ taskId: "sample", agentId: "sol-low" });
  repository.update(running.id, { stage: "building" });
  repository.update(completed.id, { stage: "completed" });

  expect(
    reconcileAbandonedRuns(repository, () => "2026-09-01T12:00:00.000Z"),
  ).toBe(2);
  expect(repository.get(queued.id)).toMatchObject({
    stage: "failed",
    failureCode: "agent_failed",
    completedAt: "2026-09-01T12:00:00.000Z",
  });
  expect(repository.get(running.id)).toMatchObject({
    stage: "failed",
    failureCode: "build_failed",
  });
  expect(repository.get(completed.id)?.stage).toBe("completed");
  expect(repository.listEvents(queued.id).at(-1)).toMatchObject({
    kind: "stage",
    payload: { stage: "failed", recovery: true },
  });
  repository.close();
});

test("persists an unexpected detached queue failure and publishes its event", () => {
  const repository = new SqliteRunRepository(":memory:");
  const events = new RunEventBus();
  const seen: Array<Record<string, unknown>> = [];
  const run = repository.create({ taskId: "sample", agentId: "sol-low" });
  events.subscribe(run.id, (event) => seen.push(event.payload));

  persistDetachedQueueFailure({
    repository,
    events,
    runId: run.id,
    error: new Error("queue callback exploded"),
    now: () => "2026-09-01T12:01:00.000Z",
  });

  expect(repository.get(run.id)).toMatchObject({
    stage: "failed",
    failureCode: "agent_failed",
    failureDetail: "Detached queue failure: queue callback exploded",
  });
  expect(seen).toEqual([
    { stage: "failed", failureCode: "agent_failed", detached: true },
  ]);
  repository.close();
});

test("server container singleton survives module reload factories", () => {
  const key = `agentbench-test-${crypto.randomUUID()}`;
  const first = { id: "first" };
  expect(getOrCreateGlobalServerContainer(key, () => first)).toBe(first);
  expect(
    getOrCreateGlobalServerContainer(key, () => ({ id: "second" })),
  ).toBe(first);
});
