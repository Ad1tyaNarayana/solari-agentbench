import type Database from "better-sqlite3";

const IDENTITY_COLUMNS = [
  ["benchmark_id", "TEXT"], ["benchmark_version", "TEXT"],
  ["benchmark_digest", "TEXT"], ["snapshot_path", "TEXT"],
  ["provider_id", "TEXT"], ["harness_id", "TEXT"], ["harness_version", "TEXT"],
] as const;

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
}
