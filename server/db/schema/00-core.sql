-- Identity, sessions, mail, audit. Portable SQL: text UUIDs, ISO-8601 text timestamps from app code,
-- 0/1 booleans, JSON stored as TEXT.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT,
  email_verified_at TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  bio TEXT NOT NULL DEFAULT '',
  active_workspace_id TEXT,
  terms_accepted_at TEXT,
  is_synthetic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- One-time links: purpose = verify | reset. Only the hash is stored.
CREATE TABLE IF NOT EXISTS email_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens(user_id, purpose);

-- Every message Rivet sends. Without a provider key this is what /dev/outbox reads.
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  link TEXT,
  purpose TEXT NOT NULL,
  delivered_via TEXT NOT NULL CHECK (delivered_via IN ('dev', 'resend')),
  provider_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- Append-only. Triggers below refuse edits.
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  subject_code TEXT,
  workspace_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_subject ON audit_log(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS audit_workspace ON audit_log(workspace_id, created_at);
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- Identity links. These never grant private-content access or reviewer credentials.
CREATE TABLE IF NOT EXISTS connected_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL CHECK (provider IN ('github', 'linkedin', 'huggingface')),
  provider_user_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  profile_url TEXT,
  visibility_note TEXT NOT NULL DEFAULT 'Public identity',
  is_synthetic INTEGER NOT NULL DEFAULT 0,
  connected_at TEXT NOT NULL,
  disconnected_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS connected_active ON connected_accounts(user_id, provider) WHERE disconnected_at IS NULL;

-- Content-addressed bytes; the file itself lives at <dataDir>/uploads/<sha256>.
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  owner_id TEXT REFERENCES users(id),
  purpose TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  field TEXT NOT NULL,
  prefix TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  research_focus TEXT NOT NULL DEFAULT '',
  default_visibility TEXT NOT NULL DEFAULT 'private' CHECK (default_visibility IN ('private', 'shared')),
  owner_id TEXT NOT NULL REFERENCES users(id),
  is_synthetic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at TEXT NOT NULL,
  removed_at TEXT,
  UNIQUE (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS memberships_user ON memberships(user_id, status);

CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'accepted', 'revoked')),
  invited_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  accepted_by TEXT
);
CREATE INDEX IF NOT EXISTS invitations_workspace ON invitations(workspace_id, status);
