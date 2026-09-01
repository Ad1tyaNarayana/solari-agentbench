PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runs (
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

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, sequence)
);
