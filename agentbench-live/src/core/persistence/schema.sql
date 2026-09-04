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
  cleanup_issues TEXT NOT NULL DEFAULT '[]',
  benchmark_id TEXT,
  benchmark_version TEXT,
  benchmark_digest TEXT,
  snapshot_path TEXT,
  provider_id TEXT,
  harness_id TEXT,
  harness_version TEXT,
  resolved_model TEXT,
  provider_options TEXT,
  tool_policy TEXT,
  usage TEXT,
  evaluation_status TEXT,
  primary_score REAL,
  evaluation_report TEXT,
  evidence_manifest TEXT
);

CREATE TABLE IF NOT EXISTS evaluator_results (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  declaration_order INTEGER NOT NULL,
  evaluator_id TEXT NOT NULL,
  status TEXT NOT NULL,
  earned_points REAL NOT NULL,
  possible_points REAL NOT NULL,
  summary TEXT NOT NULL,
  outputs TEXT NOT NULL,
  metadata TEXT NOT NULL,
  PRIMARY KEY (run_id, evaluator_id)
);

CREATE TABLE IF NOT EXISTS evaluator_assertions (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  evaluator_id TEXT NOT NULL,
  assertion_order INTEGER NOT NULL,
  assertion_id TEXT NOT NULL,
  passed INTEGER NOT NULL,
  summary TEXT NOT NULL,
  expected TEXT,
  observed TEXT,
  PRIMARY KEY (run_id, evaluator_id, assertion_order)
);

CREATE TABLE IF NOT EXISTS evidence_references (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  reference_order INTEGER NOT NULL,
  digest TEXT NOT NULL,
  role TEXT NOT NULL,
  reference_json TEXT NOT NULL,
  PRIMARY KEY (run_id, reference_order)
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
