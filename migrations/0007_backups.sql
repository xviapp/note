CREATE TABLE backup_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('export','restore')),
  digest TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL,
  root_id TEXT
);
CREATE TABLE backup_parts (
  job_id TEXT NOT NULL REFERENCES backup_jobs(id) ON DELETE CASCADE,
  part INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY(job_id,part)
);
CREATE TABLE backup_files (
  job_id TEXT NOT NULL REFERENCES backup_jobs(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  blob_id TEXT REFERENCES blobs(id) ON DELETE RESTRICT,
  PRIMARY KEY(job_id,source_id)
);
CREATE INDEX backup_files_blob ON backup_files(blob_id);
-- Present only inside the atomic restore transaction, for newly allocated node IDs.
-- This permits inserting retained historical revisions in bulk without weakening
-- the ordinary optimistic-concurrency checks after the transaction commits.
CREATE TABLE backup_restore_nodes (node_id TEXT PRIMARY KEY);
DROP TRIGGER version_guard;
CREATE TRIGGER version_guard BEFORE INSERT ON versions BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM nodes WHERE id=NEW.node_id AND trash_id IS NULL
    AND (revision=NEW.sequence-1 OR EXISTS(SELECT 1 FROM backup_restore_nodes r WHERE r.node_id=NEW.node_id))
    AND (kind IN ('markdown','text') OR (kind='link' AND arxiv_id IS NOT NULL)))
    THEN RAISE(ABORT,'VERSION_CONFLICT') END);
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.body_blob_id AND state='ready')
    THEN RAISE(ABORT,'FILE_UNAVAILABLE') END);
END;
