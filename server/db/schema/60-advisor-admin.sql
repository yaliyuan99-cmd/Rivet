-- Audit Advisor threads and administration receipts.

CREATE TABLE IF NOT EXISTS advisor_threads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  task_version_id TEXT NOT NULL REFERENCES task_versions(id),
  created_at TEXT NOT NULL,
  UNIQUE (user_id, task_version_id)
);

CREATE TABLE IF NOT EXISTS advisor_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES advisor_threads(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  citations TEXT NOT NULL DEFAULT '[]', -- JSON: [{ n, label, detail, to }]
  insufficient INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'retrieval' CHECK (mode IN ('retrieval', 'llm', 'authored')),
  mode_note TEXT,                     -- why retrieval answered when the LLM mode was on
  seq INTEGER NOT NULL,               -- order inside the thread; a question and its answer share a clock tick
  created_at TEXT NOT NULL,
  UNIQUE (thread_id, seq)
);

CREATE TABLE IF NOT EXISTS check_runs (
  id TEXT PRIMARY KEY,
  started_by TEXT NOT NULL REFERENCES users(id),
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS check_receipts (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,          -- CHECK-291
  check_run_id TEXT NOT NULL REFERENCES check_runs(id),
  check_key TEXT NOT NULL,            -- artifact_hashes, immutability, ...
  label TEXT NOT NULL,                -- Artifact hashes
  status TEXT NOT NULL CHECK (status IN ('passed', 'warning', 'failed')),
  detail TEXT NOT NULL,               -- Passed · 72 of 72 verified
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS check_receipts_run ON check_receipts(check_run_id);

-- "Integrity failures block runs." The newest check run decides, until a later one passes.
-- This holds for every path that starts or resumes a run, whatever the route in front of it does.
CREATE TRIGGER IF NOT EXISTS runs_start_blocked_by_integrity BEFORE INSERT ON runs
WHEN EXISTS (
  SELECT 1 FROM check_receipts r
  WHERE r.status = 'failed' AND r.check_key IN ('artifact_hashes', 'immutability')
    AND r.check_run_id = (SELECT id FROM check_runs ORDER BY rowid DESC LIMIT 1)
)
BEGIN SELECT RAISE(ABORT, 'integrity_block: the latest system check found an integrity failure'); END;
CREATE TRIGGER IF NOT EXISTS runs_resume_blocked_by_integrity BEFORE UPDATE OF status ON runs
WHEN OLD.status = 'interrupted' AND NEW.status = 'queued' AND EXISTS (
  SELECT 1 FROM check_receipts r
  WHERE r.status = 'failed' AND r.check_key IN ('artifact_hashes', 'immutability')
    AND r.check_run_id = (SELECT id FROM check_runs ORDER BY rowid DESC LIMIT 1)
)
BEGIN SELECT RAISE(ABORT, 'integrity_block: the latest system check found an integrity failure'); END;
