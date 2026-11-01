-- Agent assurance: traces, expert findings, regressions and release gates.

CREATE TABLE IF NOT EXISTS gates (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,          -- GATE-019
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  domain_id TEXT REFERENCES domains(id),
  target TEXT NOT NULL,               -- Helix Lab Biology agent
  suite TEXT NOT NULL,                -- biology-gate v1
  suite_size INTEGER NOT NULL,        -- 30
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,          -- TRACE-042
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  task_version_id TEXT REFERENCES task_versions(id),
  dataset_version_id TEXT REFERENCES dataset_versions(id),
  domain_id TEXT NOT NULL REFERENCES domains(id),
  gate_id TEXT REFERENCES gates(id),  -- the release gate this candidate goes through
  candidate TEXT,                     -- rc.18
  agent_label TEXT NOT NULL,          -- Aster 3.2 agent
  model_id TEXT,                      -- aster-3.2, when the agent wraps a registered model
  harness_version TEXT NOT NULL,      -- 0.8.18
  steps TEXT NOT NULL,                -- JSON: [{ n, title, call?, claim?, detail?, sources?, status }]
  change_note TEXT NOT NULL DEFAULT '',
  sha256 TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS traces_gate_candidate ON traces(gate_id, candidate);
CREATE INDEX IF NOT EXISTS traces_workspace ON traces(workspace_id, created_at);
CREATE TRIGGER IF NOT EXISTS traces_no_update BEFORE UPDATE ON traces
BEGIN SELECT RAISE(ABORT, 'traces are immutable'); END;
CREATE TRIGGER IF NOT EXISTS traces_no_delete BEFORE DELETE ON traces
BEGIN SELECT RAISE(ABORT, 'traces are immutable'); END;

-- Append-only. kind: finding | clarification
CREATE TABLE IF NOT EXISTS trace_adjudications (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,                 -- ADJ-TRACE-042; a clarification is CLAR-TRACE-001
  trace_id TEXT NOT NULL REFERENCES traces(id),
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('finding', 'clarification')),
  finding TEXT NOT NULL,
  severity TEXT NOT NULL,
  rationale TEXT NOT NULL,
  conflict_ack INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trace_adjudications_trace ON trace_adjudications(trace_id, created_at);
CREATE TRIGGER IF NOT EXISTS trace_adjudications_no_update BEFORE UPDATE ON trace_adjudications
BEGIN SELECT RAISE(ABORT, 'trace_adjudications are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trace_adjudications_no_delete BEFORE DELETE ON trace_adjudications
BEGIN SELECT RAISE(ABORT, 'trace_adjudications are append-only'); END;

CREATE TABLE IF NOT EXISTS regressions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,          -- REG-BIO-042
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  source_adjudication_id TEXT REFERENCES trace_adjudications(id),
  task_version_id TEXT REFERENCES task_versions(id),
  dataset_version_id TEXT REFERENCES dataset_versions(id),
  gate_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active')),
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  activated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS regressions_source ON regressions(source_adjudication_id);
-- An active regression stays active: dropping a safeguard would be a bypass.
CREATE TRIGGER IF NOT EXISTS regressions_stay_active BEFORE UPDATE OF status ON regressions
WHEN OLD.status = 'active' AND NEW.status <> 'active'
BEGIN SELECT RAISE(ABORT, 'an active regression cannot be deactivated'); END;
CREATE TRIGGER IF NOT EXISTS regressions_no_delete BEFORE DELETE ON regressions
BEGIN SELECT RAISE(ABORT, 'regressions cannot be deleted'); END;

-- Changes to a regression create a new rule version; old rows never change.
CREATE TABLE IF NOT EXISTS regression_versions (
  id TEXT PRIMARY KEY,
  regression_id TEXT NOT NULL REFERENCES regressions(id),
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  pass_condition TEXT NOT NULL,
  policy TEXT NOT NULL,               -- block_high | block_any
  scope TEXT NOT NULL,
  scope_ack INTEGER NOT NULL,
  rule TEXT NOT NULL DEFAULT 'causal_claim_requires_control',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (regression_id, version)
);
CREATE TRIGGER IF NOT EXISTS regression_versions_no_update BEFORE UPDATE ON regression_versions
BEGIN SELECT RAISE(ABORT, 'regression_versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS regression_versions_no_delete BEFORE DELETE ON regression_versions
BEGIN SELECT RAISE(ABORT, 'regression_versions are immutable'); END;

-- Immutable after insert apart from nothing: decisions go in release_decisions.
CREATE TABLE IF NOT EXISTS gate_runs (
  id TEXT PRIMARY KEY,
  gate_id TEXT NOT NULL REFERENCES gates(id),
  candidate TEXT NOT NULL,            -- rc.18
  harness_version TEXT NOT NULL,
  trace_id TEXT NOT NULL REFERENCES traces(id),
  status TEXT NOT NULL CHECK (status IN ('blocked', 'passed')),
  checks TEXT NOT NULL,               -- JSON: [{ id, group, label, status, detail, required, severity, regressions?, blocking, step? }]
  groups TEXT NOT NULL DEFAULT '[]',  -- JSON: the four frame groups, derived from checks
  regressions TEXT NOT NULL DEFAULT '[]', -- JSON: the regression versions this run enforced
  blocking_reason TEXT,               -- "High-severity REG-BIO-042 failed"
  passed_count INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  change_note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (gate_id, candidate)
);
CREATE TRIGGER IF NOT EXISTS gate_runs_no_update BEFORE UPDATE ON gate_runs
BEGIN SELECT RAISE(ABORT, 'gate_runs are immutable'); END;
CREATE TRIGGER IF NOT EXISTS gate_runs_no_delete BEFORE DELETE ON gate_runs
BEGIN SELECT RAISE(ABORT, 'gate_runs are immutable'); END;

CREATE TABLE IF NOT EXISTS release_decisions (
  id TEXT PRIMARY KEY,
  gate_run_id TEXT NOT NULL UNIQUE REFERENCES gate_runs(id),
  decided_by TEXT NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved')),
  created_at TEXT NOT NULL
);
-- There is no bypass: a decision can only ever follow a passed run, whichever code writes it.
CREATE TRIGGER IF NOT EXISTS release_decisions_require_pass BEFORE INSERT ON release_decisions
WHEN (SELECT status FROM gate_runs WHERE id = NEW.gate_run_id) IS NOT 'passed'
BEGIN SELECT RAISE(ABORT, 'a release can only be approved after a passed gate run'); END;
CREATE TRIGGER IF NOT EXISTS release_decisions_no_update BEFORE UPDATE ON release_decisions
BEGIN SELECT RAISE(ABORT, 'release_decisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS release_decisions_no_delete BEFORE DELETE ON release_decisions
BEGIN SELECT RAISE(ABORT, 'release_decisions are immutable'); END;
