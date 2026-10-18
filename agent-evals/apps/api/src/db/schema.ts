export const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  prompt       TEXT NOT NULL,
  scorer_type  TEXT NOT NULL CHECK (scorer_type IN ('regex', 'judge')),
  scorer_spec  TEXT NOT NULL,
  reference_answer TEXT,
  files        TEXT,
  active       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS configs (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  model           TEXT NOT NULL,
  provider        TEXT NOT NULL,
  toolsets        TEXT NOT NULL,
  skills          TEXT NOT NULL,
  max_turns       INTEGER NOT NULL,
  run_budget_sec  INTEGER NOT NULL,
  mock_pass_rate  REAL CHECK (mock_pass_rate IS NULL OR (mock_pass_rate >= 0 AND mock_pass_rate <= 1))
);

CREATE TABLE IF NOT EXISTS experiments (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  config_a_id  TEXT NOT NULL REFERENCES configs(id),
  config_b_id  TEXT NOT NULL REFERENCES configs(id),
  task_ids     TEXT NOT NULL,
  repeats      INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',
  created_at   INTEGER NOT NULL,
  finished_at  INTEGER
);

CREATE TABLE IF NOT EXISTS runs (
  id             TEXT PRIMARY KEY,
  experiment_id  TEXT NOT NULL REFERENCES experiments(id),
  task_id        TEXT NOT NULL REFERENCES tasks(id),
  config_id      TEXT NOT NULL REFERENCES configs(id),
  repeat_index   INTEGER NOT NULL,
  seq            INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'running', 'done', 'error')),
  passed         INTEGER,
  score_reason   TEXT,
  judge_input_tokens  INTEGER,
  judge_output_tokens INTEGER,
  judge_cost_usd      REAL,
  final_answer   TEXT,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  cost_usd       REAL,
  duration_ms    INTEGER,
  error          TEXT,
  session_id     TEXT,
  started_at     INTEGER,
  finished_at    INTEGER
);

CREATE TABLE IF NOT EXISTS steps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  idx           INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('tool', 'result', 'model')),
  tool_name     TEXT,
  content       TEXT NOT NULL,
  timestamp_ms  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_runs_experiment ON runs(experiment_id);
CREATE INDEX IF NOT EXISTS idx_runs_queue ON runs(status, seq);
CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id);
`;
