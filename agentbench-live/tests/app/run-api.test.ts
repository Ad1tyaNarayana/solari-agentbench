import { describe, expect, test, vi } from "vitest";
import type { RunRecord } from "@/core/domain/run";
import type { RunEvent, RunEventInput } from "@/core/events/run-events";
import type { RunApiPort } from "@/server/contracts";
import { handleGetRun } from "@/app/api/runs/[id]/route";
import { handleRunEvents } from "@/app/api/runs/[id]/events/route";
import { handleGetRuns, handlePostRuns } from "@/app/api/runs/route";

const queuedRun: RunRecord = {
  id: "run-1",
  taskId: "url-shortener",
  taskVersion: "1.0.0",
  agentId: "sol-low",
  model: "gpt-5.6-sol",
  reasoningEffort: "low",
  stage: "queued",
  sanitizedLogs: [],
  createdAt: "2026-09-01T00:00:00.000Z",
};

function createApi(overrides: Partial<RunApiPort> = {}): RunApiPort {
  return {
    submit: vi.fn(async () => ({ kind: "run" as const, run: queuedRun })),
    listRuns: vi.fn(() => [queuedRun]),
    getRun: vi.fn(() => queuedRun),
    listEvents: vi.fn(() => []),
    subscribe: vi.fn(() => () => undefined),
    ...overrides,
  };
}

describe("run collection API", () => {
  test("returns a stable 400 code for an unknown task", async () => {
    const api = createApi({
      submit: vi.fn(async () => {
        throw Object.assign(new Error("Unknown task"), { code: "unknown_task" });
      }),
    });
    const request = new Request("http://localhost/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: "missing", agentId: "sol-low" }),
    });

    const response = await handlePostRuns(request, api);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "unknown_task" });
  });

  test("accepts a valid run and returns its durable queued record", async () => {
    const api = createApi();
    const request = new Request("http://localhost/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: "url-shortener", agentId: "sol-low" }),
    });

    const response = await handlePostRuns(request, api);

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ id: "run-1", stage: "queued" });
  });

  test("lists persisted runs", async () => {
    const response = await handleGetRuns(createApi());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([queuedRun]);
  });
});

test("run detail returns 404 when the record does not exist", async () => {
  const response = await handleGetRun("missing", createApi({ getRun: () => undefined }));
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "run_not_found" });
});

test("event stream replays sanitized history before subscribing live", async () => {
  const historical: RunEvent = {
    runId: "run-1",
    sequence: 1,
    kind: "log",
    payload: { message: "Bearer slr_live_supersecret" },
    createdAt: "2026-09-01T00:00:01.000Z",
  };
  let listener: ((event: RunEventInput) => void) | undefined;
  const unsubscribe = vi.fn();
  const api = createApi({
    listEvents: () => [historical],
    subscribe: (_runId, next) => {
      listener = next;
      return unsubscribe;
    },
  });
  const controller = new AbortController();

  const response = await handleRunEvents("run-1", api, controller.signal);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");

  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain("id: 1");
  expect(first).toContain("event: log");
  expect(first).toContain("Bearer [REDACTED]");
  expect(first).not.toContain("supersecret");

  listener?.({ sequence: 2, kind: "stage", payload: { stage: "planning" } });
  const second = new TextDecoder().decode((await reader.read()).value);
  expect(second).toContain("id: 2");
  expect(second).toContain('"stage":"planning"');

  controller.abort();
  await reader.cancel();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

test("event stream subscribes before its snapshot and deduplicates buffered races", async () => {
  const calls: string[] = [];
  let listener: ((event: RunEventInput) => void) | undefined;
  const first: RunEvent = {
    runId: "run-1",
    sequence: 1,
    kind: "stage",
    payload: { stage: "planning" },
    createdAt: "2026-09-01T00:00:01.000Z",
  };
  const second: RunEvent = {
    ...first,
    sequence: 2,
    payload: { stage: "generating" },
  };
  const api = createApi({
    subscribe: (_runId, next) => {
      calls.push("subscribe");
      listener = next;
      return () => undefined;
    },
    listEvents: () => {
      calls.push("snapshot");
      listener?.(second);
      return [first, second];
    },
  });
  const controller = new AbortController();
  const response = await handleRunEvents("run-1", api, controller.signal);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const chunks = [
    decoder.decode((await reader.read()).value),
    decoder.decode((await reader.read()).value),
  ].join("");

  expect(calls).toEqual(["subscribe", "snapshot"]);
  expect(chunks.match(/id: 2/g)).toHaveLength(1);
  expect(chunks.indexOf("id: 1")).toBeLessThan(chunks.indexOf("id: 2"));
  controller.abort();
  await reader.cancel();
});

test("event stream filters snapshots and live delivery by Last-Event-ID", async () => {
  let listener: ((event: RunEventInput) => void) | undefined;
  const api = createApi({
    listEvents: () => [1, 2, 3].map((sequence) => ({
      runId: "run-1",
      sequence,
      kind: "log",
      payload: { sequence },
      createdAt: "2026-09-01T00:00:01.000Z",
    })),
    subscribe: (_runId, next) => {
      listener = next;
      return () => undefined;
    },
  });
  const controller = new AbortController();
  const response = await handleRunEvents("run-1", api, controller.signal, 2);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const historical = decoder.decode((await reader.read()).value);
  expect(historical).toContain("id: 3");
  expect(historical).not.toMatch(/id: [12]/);

  listener?.({ sequence: 2, kind: "log", payload: { duplicate: true } });
  listener?.({ sequence: 4, kind: "stage", payload: { stage: "building" } });
  const live = decoder.decode((await reader.read()).value);
  expect(live).toContain("id: 4");
  expect(live).not.toContain("duplicate");
  controller.abort();
  await reader.cancel();
});
