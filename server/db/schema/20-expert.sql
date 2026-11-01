-- Reviewer applications, domain credentials, expert reviews, adjudications, reports, leaderboards.

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,          -- APP-028
  user_id TEXT NOT NULL REFERENCES users(id),
  domain_id TEXT NOT NULL REFERENCES domains(id),
  legal_name TEXT NOT NULL DEFAULT '',
  institutional_email TEXT NOT NULL DEFAULT '',
  research_background TEXT NOT NULL DEFAULT '',
  evidence_upload_id TEXT REFERENCES uploads(id),
  research_profile_url TEXT NOT NULL DEFAULT '',
  commitment_ack INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('draft', 'pending', 'more_evidence', 'verified', 'declined', 'withdrawn')),
  admin_note TEXT,
  submitted_at TEXT,
  decided_at TEXT,
  decided_by TEXT REFERENCES users(id),
  is_synthetic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS applications_user ON applications(user_id, status);
-- One open application per person per domain. A draft counts: the apply screen reuses it.
CREATE UNIQUE INDEX IF NOT EXISTS applications_one_open ON applications(user_id, domain_id) WHERE status IN ('draft', 'pending', 'more_evidence');

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  domain_id TEXT NOT NULL REFERENCES domains(id),
  application_id TEXT REFERENCES applications(id),
  rationale TEXT NOT NULL,
  granted_by TEXT REFERENCES users(id),
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS credentials_active ON credentials(user_id, domain_id) WHERE revoked_at IS NULL;

-- status: requested (in the queue) -> draft (claimed by an expert) -> submitted -> finalized, or returned -> draft
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,          -- REVIEW-042
  task_id TEXT NOT NULL REFERENCES tasks(id),
  task_version_id TEXT NOT NULL REFERENCES task_versions(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  requested_by TEXT NOT NULL REFERENCES users(id),
  expert_id TEXT REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('requested', 'draft', 'submitted', 'returned', 'finalized')),
  assessment TEXT NOT NULL DEFAULT '',
  recommendations TEXT NOT NULL DEFAULT '{}', -- JSON: { [evidenceCode]: { annotation, criteria: [{ name, short, points, score, note }] } }
  rationale TEXT NOT NULL DEFAULT '',
  finding TEXT NOT NULL DEFAULT '',   -- the expert's finding quoted at adjudication and in the report
  conflict_ack INTEGER NOT NULL DEFAULT 0,
  returned_note TEXT,
  draft_saved_at TEXT,
  submitted_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_status ON reviews(status);
-- One open review per task version. A finalized version is refused in code: its report already exists.
CREATE UNIQUE INDEX IF NOT EXISTS reviews_one_open ON reviews(task_version_id) WHERE status IN ('requested', 'draft', 'submitted', 'returned');

-- Each submission as the expert sent it, so reworking a returned review never loses what was first submitted.
CREATE TABLE IF NOT EXISTS review_submissions (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(id),
  seq INTEGER NOT NULL,
  expert_id TEXT NOT NULL REFERENCES users(id),
  assessment TEXT NOT NULL,
  recommendations TEXT NOT NULL,
  rationale TEXT NOT NULL,
  finding TEXT NOT NULL,
  conflict_ack INTEGER NOT NULL,
  submitted_at TEXT NOT NULL,
  UNIQUE (review_id, seq)
);
CREATE TRIGGER IF NOT EXISTS review_submissions_no_update BEFORE UPDATE ON review_submissions
BEGIN SELECT RAISE(ABORT, 'review_submissions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS review_submissions_no_delete BEFORE DELETE ON review_submissions
BEGIN SELECT RAISE(ABORT, 'review_submissions are append-only'); END;

-- Append-only decisions.
CREATE TABLE IF NOT EXISTS adjudications (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,                 -- ADJ-042; the code repeats if a review is returned and decided again
  review_id TEXT NOT NULL REFERENCES reviews(id),
  task_version_id TEXT NOT NULL REFERENCES task_versions(id),
  admin_id TEXT NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK (decision IN ('accept', 'return')),
  rationale TEXT NOT NULL,
  checks_ack INTEGER NOT NULL,
  report_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS adjudications_no_update BEFORE UPDATE ON adjudications
BEGIN SELECT RAISE(ABORT, 'adjudications are append-only'); END;
CREATE TRIGGER IF NOT EXISTS adjudications_no_delete BEFORE DELETE ON adjudications
BEGIN SELECT RAISE(ABORT, 'adjudications are append-only'); END;

-- Immutable after insert. sha256 covers canonical (a JSON manifest of everything the report states).
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,                 -- RPT-BIO-042
  version TEXT NOT NULL,              -- 1.0
  task_id TEXT NOT NULL REFERENCES tasks(id),
  task_version_id TEXT NOT NULL REFERENCES task_versions(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  review_id TEXT NOT NULL REFERENCES reviews(id),
  adjudication_id TEXT NOT NULL REFERENCES adjudications(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  expert_id TEXT NOT NULL REFERENCES users(id),
  admin_id TEXT NOT NULL REFERENCES users(id),
  domain_id TEXT NOT NULL REFERENCES domains(id),
  headline TEXT NOT NULL,
  summary TEXT NOT NULL,
  limitations TEXT NOT NULL,
  scores TEXT NOT NULL,               -- JSON: [{ modelId, displayName, score, label, evidenceCode, sealedScore? }]
  citation TEXT NOT NULL,
  canonical TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  frozen_at TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0,
  UNIQUE (code, version)
);
CREATE TRIGGER IF NOT EXISTS reports_no_update BEFORE UPDATE ON reports
BEGIN SELECT RAISE(ABORT, 'reports are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reports_no_delete BEFORE DELETE ON reports
BEGIN SELECT RAISE(ABORT, 'reports are immutable'); END;

-- One row per (task, model): the sample the bootstrap draws from.
-- Finalized reports add rows; authored fixtures carry is_fixture = 1.
CREATE TABLE IF NOT EXISTS leaderboard_scores (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES domains(id),
  task_label TEXT NOT NULL,           -- BIO-042 v1.0
  model_id TEXT NOT NULL,
  score REAL NOT NULL,
  report_id TEXT,
  is_fixture INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (task_label, model_id)
);
CREATE INDEX IF NOT EXISTS leaderboard_domain ON leaderboard_scores(domain_id);
