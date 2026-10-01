PRAGMA foreign_keys = ON;

CREATE TABLE site (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT,
  password_salt TEXT,
  password_iterations INTEGER NOT NULL DEFAULT 600000,
  auth_epoch INTEGER NOT NULL DEFAULT 0,
  quota_bytes INTEGER NOT NULL DEFAULT 8000000000 CHECK (quota_bytes > 0),
  allocated_bytes INTEGER NOT NULL DEFAULT 0 CHECK (allocated_bytes >= 0),
  initialized_at INTEGER
);
INSERT INTO site(id) VALUES(1);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE login_attempts (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

CREATE TABLE blobs (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending','ready','deleting')),
  draft_until INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX blobs_cleanup ON blobs(state,draft_until);
CREATE TRIGGER blob_quota BEFORE INSERT ON blobs BEGIN
  SELECT CASE WHEN (SELECT allocated_bytes + NEW.size > quota_bytes FROM site WHERE id = 1)
    THEN RAISE(ABORT, 'QUOTA_EXCEEDED') END;
END;
CREATE TRIGGER blob_allocated AFTER INSERT ON blobs BEGIN
  UPDATE site SET allocated_bytes = allocated_bytes + NEW.size WHERE id = 1;
END;
CREATE TRIGGER blob_released AFTER DELETE ON blobs BEGIN
  UPDATE site SET allocated_bytes = allocated_bytes - OLD.size WHERE id = 1;
END;

CREATE TABLE trash_batches (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  title TEXT NOT NULL,
  original_parent_id TEXT,
  expected_count INTEGER NOT NULL,
  deleted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  purging INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('folder','markdown','text','pdf','image','link')),
  title TEXT NOT NULL,
  position REAL NOT NULL,
  url TEXT,
  file_blob_id TEXT REFERENCES blobs(id) ON DELETE RESTRICT,
  current_version_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  trash_id TEXT REFERENCES trash_batches(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX nodes_parent ON nodes(parent_id,trash_id,position);
CREATE INDEX nodes_trash ON nodes(trash_id);
CREATE INDEX nodes_file ON nodes(file_blob_id);

CREATE TRIGGER node_parent_insert BEFORE INSERT ON nodes WHEN NEW.parent_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM nodes WHERE id=NEW.parent_id AND trash_id IS NULL AND kind IN ('folder','markdown','text'))
    THEN RAISE(ABORT,'INVALID_PARENT') END;
END;
CREATE TRIGGER node_parent_update BEFORE UPDATE OF parent_id ON nodes WHEN NEW.parent_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM nodes WHERE id=NEW.parent_id AND trash_id IS NULL AND kind IN ('folder','markdown','text'))
    THEN RAISE(ABORT,'INVALID_PARENT') END;
  SELECT CASE WHEN NEW.parent_id IN (
    WITH RECURSIVE subtree(id) AS (SELECT OLD.id UNION ALL SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id=s.id)
    SELECT id FROM subtree
  ) THEN RAISE(ABORT,'TREE_CYCLE') END;
END;
CREATE TRIGGER node_file_insert BEFORE INSERT ON nodes WHEN NEW.file_blob_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.file_blob_id AND state='ready')
    THEN RAISE(ABORT,'FILE_UNAVAILABLE') END;
END;
CREATE TRIGGER node_file_update BEFORE UPDATE OF file_blob_id ON nodes WHEN NEW.file_blob_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.file_blob_id AND state='ready')
    THEN RAISE(ABORT,'FILE_UNAVAILABLE') END;
END;
CREATE TRIGGER node_file_retained AFTER INSERT ON nodes WHEN NEW.file_blob_id IS NOT NULL BEGIN
  UPDATE blobs SET draft_until=NULL WHERE id=NEW.file_blob_id;
END;

CREATE TABLE versions (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  body_blob_id TEXT NOT NULL REFERENCES blobs(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  UNIQUE(node_id,sequence)
);
CREATE INDEX versions_node ON versions(node_id,sequence DESC);
CREATE INDEX versions_body ON versions(body_blob_id);
CREATE TABLE version_assets (
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  blob_id TEXT NOT NULL REFERENCES blobs(id) ON DELETE RESTRICT,
  PRIMARY KEY(version_id,blob_id)
);
CREATE INDEX version_assets_blob ON version_assets(blob_id);

CREATE TRIGGER version_guard BEFORE INSERT ON versions BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM nodes WHERE id=NEW.node_id AND trash_id IS NULL AND revision=NEW.sequence-1 AND kind IN ('markdown','text'))
    THEN RAISE(ABORT,'VERSION_CONFLICT') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.body_blob_id AND state='ready')
    THEN RAISE(ABORT,'FILE_UNAVAILABLE') END;
END;
CREATE TRIGGER version_retained AFTER INSERT ON versions BEGIN
  UPDATE blobs SET draft_until=NULL WHERE id=NEW.body_blob_id;
END;
CREATE TRIGGER attachment_guard BEFORE INSERT ON version_assets BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.blob_id AND state='ready')
    THEN RAISE(ABORT,'FILE_UNAVAILABLE') END;
END;
CREATE TRIGGER attachment_retained AFTER INSERT ON version_assets BEGIN
  UPDATE blobs SET draft_until=NULL WHERE id=NEW.blob_id;
END;

CREATE TRIGGER trash_guard BEFORE INSERT ON trash_batches BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM nodes WHERE id=NEW.root_id AND trash_id IS NULL)
    THEN RAISE(ABORT,'NODE_UNAVAILABLE') END;
  SELECT CASE WHEN NEW.expected_count != (
    WITH RECURSIVE subtree(id) AS (
      SELECT id FROM nodes WHERE id=NEW.root_id AND trash_id IS NULL
      UNION ALL SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id=s.id WHERE n.trash_id IS NULL
    ) SELECT COUNT(*) FROM subtree
  ) THEN RAISE(ABORT,'TREE_CHANGED') END;
END;

CREATE TABLE favorites (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TABLE reading_states (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  position TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 0,
  last_opened_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX reading_recent ON reading_states(last_opened_at DESC);

CREATE TABLE idempotency (
  key TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  node_id TEXT,
  result_revision INTEGER,
  created_at INTEGER NOT NULL
);
