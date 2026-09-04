import type Database from "better-sqlite3";

const IDENTITY_COLUMNS = [
  ["benchmark_id", "TEXT"], ["benchmark_version", "TEXT"],
  ["benchmark_digest", "TEXT"], ["snapshot_path", "TEXT"],
  ["provider_id", "TEXT"], ["harness_id", "TEXT"], ["harness_version", "TEXT"],
] as const;

const EXECUTION_COLUMNS = [
  ["resolved_model", "TEXT"],
  ["provider_options", "TEXT"],
  ["tool_policy", "TEXT"],
  ["usage", "TEXT"],
] as const;
const EVALUATION_COLUMNS = [["evaluation_status", "TEXT"], ["primary_score", "REAL"], ["evaluation_report", "TEXT"], ["evidence_manifest", "TEXT"]] as const;
const EVALUATION_TABLES = `
CREATE TABLE IF NOT EXISTS evaluator_results (run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, declaration_order INTEGER NOT NULL, evaluator_id TEXT NOT NULL, status TEXT NOT NULL, earned_points REAL NOT NULL, possible_points REAL NOT NULL, summary TEXT NOT NULL, outputs TEXT NOT NULL, metadata TEXT NOT NULL, PRIMARY KEY (run_id, evaluator_id));
CREATE TABLE IF NOT EXISTS evaluator_assertions (run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, evaluator_id TEXT NOT NULL, assertion_order INTEGER NOT NULL, assertion_id TEXT NOT NULL, passed INTEGER NOT NULL, summary TEXT NOT NULL, expected TEXT, observed TEXT, PRIMARY KEY (run_id, evaluator_id, assertion_order));
CREATE TABLE IF NOT EXISTS evidence_references (run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, reference_order INTEGER NOT NULL, digest TEXT NOT NULL, role TEXT NOT NULL, reference_json TEXT NOT NULL, PRIMARY KEY (run_id, reference_order));`;

function hasTable(database: Database.Database, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

export function migrateDatabase(database: Database.Database): void {
  let version = database.pragma("user_version", { simple: true }) as number;
  if (!hasTable(database, "runs")) return;
  if (version === 0) {
    database.transaction(() => database.pragma("user_version = 1")).immediate();
    version = 1;
  }
  if (version < 2) {
    database.transaction(() => {
      const columns = new Set((database.pragma("table_info(runs)") as Array<{ name: string }>).map((column) => column.name));
      for (const [name, type] of IDENTITY_COLUMNS) {
        if (!columns.has(name)) database.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
      }
      database.pragma("user_version = 2");
    }).immediate();
  }
  if (version < 3) {
    database.transaction(() => {
      const columns = new Set((database.pragma("table_info(runs)") as Array<{ name: string }>).map((column) => column.name));
      for (const [name, type] of EXECUTION_COLUMNS) {
        if (!columns.has(name)) database.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
      }
      database.pragma("user_version = 3");
    }).immediate();
  }
  if (version < 4) {
    database.transaction(() => {
      const columns = new Set((database.pragma("table_info(runs)") as Array<{ name: string }>).map((column) => column.name));
      for (const [name, type] of EVALUATION_COLUMNS) if (!columns.has(name)) database.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
      database.exec(EVALUATION_TABLES);
      database.pragma("user_version = 4");
    }).immediate();
  }
}
