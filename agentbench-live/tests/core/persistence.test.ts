import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
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

test(
  "allocates and inserts event sequences transactionally across connections",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentbench-events-"));
    const databasePath = join(directory, "events.sqlite");
    const workerPath = join(directory, "append-events.mjs");
    try {
      repository = new SqliteRunRepository(databasePath);
      const run = repository.create({ taskId: "sample", agentId: "sol-low" });
      repository.close();
      repository = undefined;
      await writeFile(
        workerPath,
        `const [moduleUrl, databasePath, runId, count, startAt] = process.argv.slice(2);
const { SqliteRunRepository } = await import(moduleUrl);
const repository = new SqliteRunRepository(databasePath);
while (Date.now() < Number(startAt)) {}
for (let index = 0; index < Number(count); index += 1) {
  repository.appendEvent(runId, { kind: "log", payload: { index } });
}
repository.close();
`,
        "utf8",
      );
      const execute = promisify(execFile);
      const tsxCli = resolve("node_modules/tsx/dist/cli.mjs");
      const moduleUrl = pathToFileURL(
        resolve("src/core/persistence/sqlite-repository.ts"),
      ).href;
      const workers = 6;
      const eventsPerWorker = 50;
      const startAt = Date.now() + 800;
      await Promise.all(
        Array.from({ length: workers }, () =>
          execute(
            process.execPath,
            [
              tsxCli,
              workerPath,
              moduleUrl,
              databasePath,
              run.id,
              String(eventsPerWorker),
              String(startAt),
            ],
            { cwd: resolve("."), timeout: 10_000 },
          ),
        ),
      );

      repository = new SqliteRunRepository(databasePath);
      expect(repository.listEvents(run.id).map((event) => event.sequence)).toEqual(
        Array.from(
          { length: workers * eventsPerWorker },
          (_unused, index) => index + 1,
        ),
      );
    } finally {
      repository?.close();
      repository = undefined;
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  },
  15_000,
);
