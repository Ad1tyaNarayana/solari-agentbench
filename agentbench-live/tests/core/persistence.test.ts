import { execFile } from "node:child_process";
import Database from "better-sqlite3";
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

test("migrates legacy runs and round-trips snapshot comparability identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentbench-migration-"));
  const databasePath = join(directory, "legacy.sqlite");
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      task_version TEXT,
      agent_id TEXT NOT NULL,
      model TEXT,
      reasoning_effort TEXT,
      stage TEXT NOT NULL,
      last_successful_stage TEXT,
      run_plan TEXT,
      score TEXT,
      evidence TEXT,
      failure_code TEXT,
      failure_detail TEXT,
      sanitized_logs TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      duration_ms INTEGER,
      cleanup_issues TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(run_id, sequence)
    );
    INSERT INTO runs (
      id, task_id, agent_id, stage, sanitized_logs, created_at
    ) VALUES ('legacy-run', 'legacy-task', 'legacy-agent', 'completed', '[]', '2026-01-01T00:00:00.000Z');
  `);
  legacy.close();

  repository = new SqliteRunRepository(databasePath);
  const created = repository.create({
    taskId: "snapshot-task",
    agentId: "provider-agent",
    benchmarkId: "benchmark-id",
    benchmarkVersion: "v3",
    benchmarkDigest: "sha256:abc",
    snapshotPath: ".agentbench/snapshots/sha256-abc",
    providerId: "provider-id",
    harnessId: "harness-id",
    harnessVersion: "2026.09",
  });
  repository.update(created.id, { stage: "completed" });
  repository.close();
  repository = new SqliteRunRepository(databasePath);

  const legacyRun = repository.get("legacy-run");
  expect(legacyRun).toMatchObject({ id: "legacy-run", taskId: "legacy-task" });
  expect(legacyRun?.benchmarkId).toBeUndefined();
  expect(legacyRun?.harnessVersion).toBeUndefined();
  expect(repository.get(created.id)).toMatchObject({
    benchmarkId: "benchmark-id",
    benchmarkVersion: "v3",
    benchmarkDigest: "sha256:abc",
    snapshotPath: ".agentbench/snapshots/sha256-abc",
    providerId: "provider-id",
    harnessId: "harness-id",
    harnessVersion: "2026.09",
  });
  const check = new Database(databasePath);
  expect(check.pragma("user_version", { simple: true }) as number).toBe(2);
  check.close();
  repository.close();
  repository = undefined;
  await rm(directory, { recursive: true, force: true });
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
