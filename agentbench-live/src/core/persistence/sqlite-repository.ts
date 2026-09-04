import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import type { RunRecord } from "@/core/domain/run";
import type { RunEvent } from "@/core/events/run-events";
import type {
  AppendRunEventInput,
  CreateRunInput,
  RunRepository,
  RunUpdate,
} from "./repository";
import { migrateDatabase } from "./migrations";

type RunRow = {
  id: string;
  task_id: string;
  task_version: string | null;
  agent_id: string;
  model: string | null;
  reasoning_effort: "low" | "high" | null;
  stage: RunRecord["stage"];
  last_successful_stage: RunRecord["lastSuccessfulStage"] | null;
  run_plan: string | null;
  score: string | null;
  evidence: string | null;
  failure_code: RunRecord["failureCode"] | null;
  failure_detail: string | null;
  sanitized_logs: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  cleanup_issues: string;
  benchmark_id: string | null;
  benchmark_version: string | null;
  benchmark_digest: string | null;
  snapshot_path: string | null;
  provider_id: string | null;
  harness_id: string | null;
  harness_version: string | null;
  resolved_model: string | null;
  provider_options: string | null;
  tool_policy: string | null;
  usage: string | null;
};

type EventRow = {
  run_id: string;
  sequence: number;
  kind: string;
  payload: string;
  created_at: string;
};

function optionalJson<T>(value: string | null): T | undefined {
  return value === null ? undefined : (JSON.parse(value) as T);
}

function fromRunRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    taskVersion: row.task_version ?? undefined,
    agentId: row.agent_id,
    model: row.model ?? undefined,
    reasoningEffort: row.reasoning_effort ?? undefined,
    stage: row.stage,
    lastSuccessfulStage: row.last_successful_stage ?? undefined,
    runPlan: optionalJson(row.run_plan),
    score: optionalJson(row.score),
    evidence: optionalJson(row.evidence),
    failureCode: row.failure_code ?? undefined,
    failureDetail: row.failure_detail ?? undefined,
    sanitizedLogs: JSON.parse(row.sanitized_logs) as string[],
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    cleanupIssues: JSON.parse(row.cleanup_issues) as NonNullable<
      RunRecord["cleanupIssues"]
    >,
    benchmarkId: row.benchmark_id ?? undefined,
    benchmarkVersion: row.benchmark_version ?? undefined,
    benchmarkDigest: row.benchmark_digest ?? undefined,
    snapshotPath: row.snapshot_path ?? undefined,
    providerId: row.provider_id ?? undefined,
    harnessId: row.harness_id ?? undefined,
    harnessVersion: row.harness_version ?? undefined,
    resolvedModel: row.resolved_model ?? undefined,
    providerOptions: optionalJson(row.provider_options),
    toolPolicy: optionalJson(row.tool_policy),
    usage: optionalJson(row.usage),
  };
}

function fromEventRow(row: EventRow): RunEvent {
  return {
    runId: row.run_id,
    sequence: row.sequence,
    kind: row.kind,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

export class SqliteRunRepository implements RunRepository {
  private readonly database: Database.Database;

  constructor(path: string) {
    this.database = new Database(path);
    this.database.pragma("busy_timeout = 5000");
    if (path !== ":memory:") this.database.pragma("journal_mode = WAL");
    const hasRuns = Boolean(this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get());
    const schema = readFileSync(resolve("src/core/persistence/schema.sql"), "utf8");
    if (hasRuns) {
      migrateDatabase(this.database);
      this.database.exec(schema);
    } else {
      this.database.transaction(() => {
        this.database.exec(schema);
        this.database.pragma("user_version = 3");
      }).immediate();
    }
  }

  create(input: CreateRunInput): RunRecord {
    const record: RunRecord = {
      id: randomUUID(),
      taskId: input.taskId,
      taskVersion: input.taskVersion,
      agentId: input.agentId,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      stage: "queued",
      sanitizedLogs: [],
      createdAt: new Date().toISOString(),
      benchmarkId: input.benchmarkId,
      benchmarkVersion: input.benchmarkVersion,
      benchmarkDigest: input.benchmarkDigest,
      snapshotPath: input.snapshotPath,
      providerId: input.providerId,
      harnessId: input.harnessId,
      harnessVersion: input.harnessVersion,
    };
    this.insert(record);
    return record;
  }

  get(id: string): RunRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM runs WHERE id = ?")
      .get(id) as RunRow | undefined;
    return row ? fromRunRow(row) : undefined;
  }

  list(): RunRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM runs ORDER BY created_at DESC")
      .all() as RunRow[];
    return rows.map(fromRunRow);
  }

  update(id: string, patch: RunUpdate): RunRecord {
    const current = this.get(id);
    if (!current) throw new Error(`Unknown run: ${id}`);
    const updated = { ...current, ...patch };
    this.persistUpdate(updated);
    return updated;
  }

  appendEvent(runId: string, input: AppendRunEventInput): RunEvent {
    const append = this.database.transaction(
      (activeRunId: string, eventInput: AppendRunEventInput): RunEvent => {
        if (!this.get(activeRunId)) {
          throw new Error(`Unknown run: ${activeRunId}`);
        }
        const sequence = (
          this.database
            .prepare(
              "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM run_events WHERE run_id = ?",
            )
            .get(activeRunId) as { sequence: number }
        ).sequence;
        const event: RunEvent = {
          runId: activeRunId,
          sequence,
          kind: eventInput.kind,
          payload: eventInput.payload,
          createdAt: new Date().toISOString(),
        };
        this.database
          .prepare(
            "INSERT INTO run_events (run_id, sequence, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            event.runId,
            event.sequence,
            event.kind,
            JSON.stringify(event.payload),
            event.createdAt,
          );
        return event;
      },
    );
    return append.immediate(runId, input);
  }

  listEvents(runId: string): RunEvent[] {
    const rows = this.database
      .prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence")
      .all(runId) as EventRow[];
    return rows.map(fromEventRow);
  }

  close(): void {
    this.database.close();
  }

  private insert(record: RunRecord): void {
    this.database
      .prepare(`INSERT INTO runs (
        id, task_id, task_version, agent_id, model, reasoning_effort, stage,
        last_successful_stage, run_plan, score, evidence, failure_code,
        failure_detail, sanitized_logs, created_at, started_at, completed_at,
        duration_ms, cleanup_issues, benchmark_id, benchmark_version, benchmark_digest,
        snapshot_path, provider_id, harness_id, harness_version, resolved_model,
        provider_options, tool_policy, usage
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        record.id,
        record.taskId,
        record.taskVersion ?? null,
        record.agentId,
        record.model ?? null,
        record.reasoningEffort ?? null,
        record.stage,
        record.lastSuccessfulStage ?? null,
        record.runPlan ? JSON.stringify(record.runPlan) : null,
        record.score ? JSON.stringify(record.score) : null,
        record.evidence ? JSON.stringify(record.evidence) : null,
        record.failureCode ?? null,
        record.failureDetail ?? null,
        JSON.stringify(record.sanitizedLogs),
        record.createdAt,
        record.startedAt ?? null,
        record.completedAt ?? null,
        record.durationMs ?? null,
        JSON.stringify(record.cleanupIssues ?? []),
        record.benchmarkId ?? null,
        record.benchmarkVersion ?? null,
        record.benchmarkDigest ?? null,
        record.snapshotPath ?? null,
        record.providerId ?? null,
        record.harnessId ?? null,
        record.harnessVersion ?? null,
        record.resolvedModel ?? null,
        record.providerOptions ? JSON.stringify(record.providerOptions) : null,
        record.toolPolicy ? JSON.stringify(record.toolPolicy) : null,
        record.usage ? JSON.stringify(record.usage) : null,
      );
  }

  private persistUpdate(record: RunRecord): void {
    this.database
      .prepare(`UPDATE runs SET
        task_version = ?, model = ?, reasoning_effort = ?, stage = ?,
        last_successful_stage = ?, run_plan = ?, score = ?, evidence = ?,
        failure_code = ?, failure_detail = ?, sanitized_logs = ?, started_at = ?,
        completed_at = ?, duration_ms = ?, cleanup_issues = ?, benchmark_id = ?, benchmark_version = ?,
        benchmark_digest = ?, snapshot_path = ?, provider_id = ?, harness_id = ?, harness_version = ?,
        resolved_model = ?, provider_options = ?, tool_policy = ?, usage = ?
      WHERE id = ?`)
      .run(
        record.taskVersion ?? null,
        record.model ?? null,
        record.reasoningEffort ?? null,
        record.stage,
        record.lastSuccessfulStage ?? null,
        record.runPlan ? JSON.stringify(record.runPlan) : null,
        record.score ? JSON.stringify(record.score) : null,
        record.evidence ? JSON.stringify(record.evidence) : null,
        record.failureCode ?? null,
        record.failureDetail ?? null,
        JSON.stringify(record.sanitizedLogs),
        record.startedAt ?? null,
        record.completedAt ?? null,
        record.durationMs ?? null,
        JSON.stringify(record.cleanupIssues ?? []),
        record.benchmarkId ?? null,
        record.benchmarkVersion ?? null,
        record.benchmarkDigest ?? null,
        record.snapshotPath ?? null,
        record.providerId ?? null,
        record.harnessId ?? null,
        record.harnessVersion ?? null,
        record.resolvedModel ?? null,
        record.providerOptions ? JSON.stringify(record.providerOptions) : null,
        record.toolPolicy ? JSON.stringify(record.toolPolicy) : null,
        record.usage ? JSON.stringify(record.usage) : null,
        record.id,
      );
  }
}
