-- OAuth 2 authorization code flow with PKCE, for external AI clients.

CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,     -- client_atlas_demo
  name TEXT NOT NULL,
  developer TEXT NOT NULL,
  description TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- A consent request. expires_at is ten minutes after creation.
CREATE TABLE IF NOT EXISTS oauth_requests (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,          -- OAUTH-042
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  user_id TEXT REFERENCES users(id),
  workspace_id TEXT REFERENCES workspaces(id),
  scopes TEXT NOT NULL,               -- JSON: ["tasks:read", ...]
  resource TEXT NOT NULL,             -- task:BIO-042
  task_id TEXT NOT NULL REFERENCES tasks(id),
  task_version_id TEXT NOT NULL REFERENCES task_versions(id),
  redirect_uri TEXT NOT NULL,
  state TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL CHECK (code_challenge_method = 'S256'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  auth_code_hash TEXT,                -- sha256 of the one-time code; the code itself is never stored
  auth_code_expires_at TEXT,
  auth_code_used_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT
);
-- Reloading /oauth/authorize finds the same request; a fresh one needs a new state and challenge.
CREATE UNIQUE INDEX IF NOT EXISTS oauth_requests_attempt ON oauth_requests(client_id, user_id, state, code_challenge);
CREATE INDEX IF NOT EXISTS oauth_requests_code_hash ON oauth_requests(auth_code_hash);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES oauth_requests(id),
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,    -- sha256 of the bearer token; the token itself is never stored
  scopes TEXT NOT NULL,               -- JSON: ["tasks:read", ...]
  task_version_id TEXT NOT NULL REFERENCES task_versions(id),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS oauth_tokens_user ON oauth_tokens(user_id);
CREATE INDEX IF NOT EXISTS oauth_tokens_request ON oauth_tokens(request_id);
