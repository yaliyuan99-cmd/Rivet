-- Versioned datasets. A dataset's library entry can be removed; versions referenced by frozen evidence are retained.

CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,          -- DS-BIO-07
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  domain_id TEXT NOT NULL REFERENCES domains(id),
  name TEXT NOT NULL,
  provenance TEXT NOT NULL,           -- the newest version's statement; each version keeps its own
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared')),
  is_synthetic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS datasets_workspace ON datasets(workspace_id);

CREATE TABLE IF NOT EXISTS dataset_versions (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id),
  version TEXT NOT NULL,              -- 1.0
  upload_id TEXT NOT NULL REFERENCES uploads(id),
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('csv', 'jsonl', 'pdf')),
  sha256 TEXT NOT NULL,
  records_count INTEGER NOT NULL,
  records TEXT NOT NULL DEFAULT '[]', -- JSON: parsed records (empty for PDF)
  receipt TEXT NOT NULL,              -- JSON: see shared/types/datasets.ts
  provenance TEXT NOT NULL DEFAULT '',
  is_synthetic INTEGER NOT NULL DEFAULT 0,
  rights_ack INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (dataset_id, version)
);
CREATE TRIGGER IF NOT EXISTS dataset_versions_no_update BEFORE UPDATE ON dataset_versions
BEGIN SELECT RAISE(ABORT, 'dataset_versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS dataset_versions_no_delete BEFORE DELETE ON dataset_versions
BEGIN SELECT RAISE(ABORT, 'dataset_versions are immutable'); END;

-- Upload previews: validated bytes waiting for a name and a rights attestation.
-- A file that fails validation keeps its receipt here but no bytes: upload_id stays NULL.
CREATE TABLE IF NOT EXISTS dataset_drafts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  upload_id TEXT REFERENCES uploads(id),
  target_dataset_id TEXT REFERENCES datasets(id), -- set when this upload is a new version
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  format TEXT NOT NULL,
  records_count INTEGER NOT NULL,
  records TEXT NOT NULL,
  receipt TEXT NOT NULL,
  passed INTEGER NOT NULL,
  consumed_at TEXT,                   -- set once this draft has created a version
  consumed_version_id TEXT REFERENCES dataset_versions(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS dataset_drafts_user ON dataset_drafts(user_id, consumed_at);

CREATE TABLE IF NOT EXISTS dataset_activity (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  dataset_id TEXT REFERENCES datasets(id),
  kind TEXT NOT NULL,                 -- Upload | Validation | Task attachment | Download | Deletion
  message TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS dataset_activity_workspace ON dataset_activity(workspace_id, created_at);

-- A deleted library entry cannot gain new attachments, whichever route tries to attach it.
-- Existing frozen references are untouched: these fire only when a reference is newly written.
CREATE TRIGGER IF NOT EXISTS tasks_no_deleted_dataset_insert BEFORE INSERT ON tasks
WHEN NEW.dataset_version_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id WHERE v.id = NEW.dataset_version_id AND d.deleted_at IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'This dataset was deleted from the library and cannot be attached to a task.'); END;

CREATE TRIGGER IF NOT EXISTS tasks_no_deleted_dataset_update BEFORE UPDATE OF dataset_version_id ON tasks
WHEN NEW.dataset_version_id IS NOT NULL AND NEW.dataset_version_id IS NOT OLD.dataset_version_id AND EXISTS (
  SELECT 1 FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id WHERE v.id = NEW.dataset_version_id AND d.deleted_at IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'This dataset was deleted from the library and cannot be attached to a task.'); END;

CREATE TRIGGER IF NOT EXISTS task_versions_no_deleted_dataset BEFORE INSERT ON task_versions
WHEN NEW.dataset_version_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id WHERE v.id = NEW.dataset_version_id AND d.deleted_at IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'This dataset was deleted from the library and cannot be pinned by a new task version.'); END;

-- "Task attachment" library activity, recorded here so it is complete whichever route attaches a dataset.
CREATE TRIGGER IF NOT EXISTS dataset_activity_task_attached AFTER UPDATE OF dataset_version_id ON tasks
WHEN NEW.dataset_version_id IS NOT NULL AND NEW.dataset_version_id IS NOT OLD.dataset_version_id
BEGIN
  INSERT INTO dataset_activity (id, workspace_id, dataset_id, kind, message, actor_id, created_at)
  SELECT lower(hex(randomblob(16))), d.workspace_id, d.id, 'Task attachment', d.code || ' v' || v.version || ' attached to ' || NEW.code, NEW.owner_id, NEW.updated_at
  FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id
  WHERE v.id = NEW.dataset_version_id;
END;

-- A task created with a dataset already chosen. Authored demo tasks are left out: their history is in the seed.
CREATE TRIGGER IF NOT EXISTS dataset_activity_task_created AFTER INSERT ON tasks
WHEN NEW.dataset_version_id IS NOT NULL AND NEW.is_synthetic = 0
BEGIN
  INSERT INTO dataset_activity (id, workspace_id, dataset_id, kind, message, actor_id, created_at)
  SELECT lower(hex(randomblob(16))), d.workspace_id, d.id, 'Task attachment', d.code || ' v' || v.version || ' attached to ' || NEW.code, NEW.owner_id, NEW.created_at
  FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id
  WHERE v.id = NEW.dataset_version_id;
END;

CREATE TRIGGER IF NOT EXISTS dataset_activity_task_pinned AFTER INSERT ON task_versions
WHEN NEW.dataset_version_id IS NOT NULL
BEGIN
  INSERT INTO dataset_activity (id, workspace_id, dataset_id, kind, message, actor_id, created_at)
  SELECT lower(hex(randomblob(16))), d.workspace_id, d.id, 'Task attachment', d.code || ' v' || v.version || ' pinned to ' || t.code, NEW.frozen_by, NEW.frozen_at
  FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id JOIN tasks t ON t.id = NEW.task_id
  WHERE v.id = NEW.dataset_version_id
    AND NOT EXISTS (
      SELECT 1 FROM dataset_activity a
      WHERE a.dataset_id = d.id AND a.kind = 'Task attachment' AND a.message = d.code || ' v' || v.version || ' pinned to ' || t.code
    );
END;
