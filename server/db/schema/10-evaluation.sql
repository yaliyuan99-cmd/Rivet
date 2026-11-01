-- Models, tasks, frozen versions, runs and sealed evidence.

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  short_name TEXT NOT NULL,           -- "Aster", used in comparisons
  letter TEXT NOT NULL,               -- evidence suffix: EV-1042-A
  revision TEXT NOT NULL UNIQUE,      -- pinned revision; never editable
  adapter TEXT NOT NULL CHECK (adapter IN ('demo', 'anthropic')),
  adapter_label TEXT NOT NULL,
  context_k INTEGER NOT NULL,
  output_k INTEGER NOT NULL,
  cutoff_disclosure TEXT NOT NULL DEFAULT 'Unknown / Not claimed',
  enabled INTEGER NOT NULL DEFAULT 1,
  is_illustrative INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Append-only metadata history.
CREATE TABLE IF NOT EXISTS model_revisions (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models(id),
  editor_id TEXT REFERENCES users(id),
  rationale TEXT NOT NULL,
  changes TEXT NOT NULL,              -- JSON: { field: { from, to } }
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS model_revisions_no_update BEFORE UPDATE ON model_revisions
BEGIN SELECT RAISE(ABORT, 'model_revisions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS model_revisions_no_delete BEFORE DELETE ON model_revisions
BEGIN SELECT RAISE(ABORT, 'model_revisions is append-only'); END;

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,          -- BIO-042
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  domain_id TEXT NOT NULL REFERENCES domains(id),
  -- Working draft. Frozen copies live in task_versions and never change.
  title TEXT NOT NULL DEFAULT '',
  short_title TEXT,                   -- browse label, e.g. "Antibiotic resistance mechanism"; NULL means use title
  featured_note TEXT,                 -- authored blurb for the browse page's Featured section
  prompt TEXT NOT NULL DEFAULT '',
  rubric TEXT NOT NULL DEFAULT '[]',  -- JSON: [{ name, short, points, guidance }]
  model_ids TEXT NOT NULL DEFAULT '[]', -- JSON: model ids
  settings TEXT NOT NULL DEFAULT '{"temperature":0.2,"seed":42,"maxOutputK":8}',
  dataset_version_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'frozen')),
  draft_version TEXT NOT NULL DEFAULT '0.1', -- the label a draft carries; 1.1 while revising
  latest_version_id TEXT,             -- newest frozen task_versions row
  is_synthetic INTEGER NOT NULL DEFAULT 0,
  draft_saved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_workspace ON tasks(workspace_id);
CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(owner_id);

-- Contamination preview. status: preview until acknowledged at freeze.
CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,          -- SCAN-042
  task_id TEXT NOT NULL REFERENCES tasks(id),
  input_hash TEXT NOT NULL,           -- what was scanned, to detect a stale preview
  findings TEXT NOT NULL,             -- JSON: see shared/types/evaluation.ts
  risk TEXT NOT NULL CHECK (risk IN ('none', 'low', 'high')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- Immutable after insert.
CREATE TABLE IF NOT EXISTS task_versions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  version TEXT NOT NULL,              -- 1.0, 1.1, ...
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  rubric TEXT NOT NULL,
  models TEXT NOT NULL,               -- JSON: [{ id, displayName, shortName, letter, revision, adapter, contextK, outputK }]
  settings TEXT NOT NULL,
  dataset_version_id TEXT,
  scan_id TEXT REFERENCES scans(id),
  acknowledgements TEXT NOT NULL,     -- JSON: [string]
  sha256 TEXT NOT NULL,
  frozen_by TEXT NOT NULL REFERENCES users(id),
  frozen_at TEXT NOT NULL,
  UNIQUE (task_id, version)
);
CREATE TRIGGER IF NOT EXISTS task_versions_no_update BEFORE UPDATE ON task_versions
BEGIN SELECT RAISE(ABORT, 'task_versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS task_versions_no_delete BEFORE DELETE ON task_versions
BEGIN SELECT RAISE(ABORT, 'task_versions are immutable'); END;

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,          -- RUN-1042
  task_id TEXT NOT NULL REFERENCES tasks(id),
  task_version_id TEXT NOT NULL REFERENCES task_versions(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'stopping', 'interrupted', 'complete', 'failed')),
  interrupt_reason TEXT CHECK (interrupt_reason IN ('owner_stop', 'provider_timeout', 'server_restart')),
  interrupt_message TEXT,
  interrupted_at TEXT,
  stages_total INTEGER NOT NULL,
  stages_done INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1,
  last_checkpoint_code TEXT,
  last_checkpoint_at TEXT,
  active_ms INTEGER NOT NULL DEFAULT 0,  -- time spent executing across attempts
  active_since TEXT,                  -- while executing: when active_ms was last brought up to date
  consequential_difference TEXT,      -- authored on the seeded run; generated from the scores on live runs
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id, created_at);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status);

-- models × (output, score, seal). seq is the execution order.
CREATE TABLE IF NOT EXISTS run_stages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  model_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('output', 'score', 'seal')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done')),
  attempt INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (run_id, seq)
);

-- Captured model output between the output and seal stages; evidence is the sealed form.
CREATE TABLE IF NOT EXISTS run_outputs (
  run_id TEXT NOT NULL REFERENCES runs(id),
  model_id TEXT NOT NULL,
  output_text TEXT,
  output_meta TEXT,                   -- JSON: adapter, token usage, stop reason
  scores TEXT,                        -- JSON: [{ name, points, score, rationale }]
  total_score REAL,
  score_label TEXT,
  score_meta TEXT,                    -- JSON: how the score was produced (demo scorer version, judge model and usage)
  PRIMARY KEY (run_id, model_id)
);

CREATE TABLE IF NOT EXISTS run_log (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  at TEXT NOT NULL,
  message TEXT NOT NULL,
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS run_log_run ON run_log(run_id, seq);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  code TEXT NOT NULL,                 -- CP-006: stages committed, zero padded
  stages_done INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS checkpoints_run ON checkpoints(run_id);

-- Immutable after insert. sha256 = sha256(canonicalJson(evidenceManifest(row))), see server/lib/evidence.ts.
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,          -- EV-1042-A
  run_id TEXT NOT NULL REFERENCES runs(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  task_version_id TEXT NOT NULL REFERENCES task_versions(id),
  model_id TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  output_text TEXT NOT NULL,
  output_meta TEXT NOT NULL DEFAULT '{}',
  scores TEXT NOT NULL,               -- JSON: [{ name, short, points, score, rationale }]
  total_score REAL NOT NULL,
  score_label TEXT NOT NULL,          -- 'demo' (synthetic) or 'judge' (LLM judged)
  runner_version TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  UNIQUE (run_id, model_id)
);
CREATE INDEX IF NOT EXISTS evidence_version ON evidence(task_version_id);
CREATE TRIGGER IF NOT EXISTS evidence_no_update BEFORE UPDATE ON evidence
BEGIN SELECT RAISE(ABORT, 'evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS evidence_no_delete BEFORE DELETE ON evidence
BEGIN SELECT RAISE(ABORT, 'evidence is immutable'); END;
