CREATE TABLE translations (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  target_language TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  location_label TEXT NOT NULL DEFAULT '',
  body_blob_id TEXT REFERENCES blobs(id) ON DELETE RESTRICT,
  active_request TEXT,
  last_request_id TEXT,
  completed_request_id TEXT,
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE(node_id,source_hash,target_language)
);
CREATE INDEX translations_node ON translations(node_id,updated_at DESC,id);
CREATE INDEX translations_body ON translations(body_blob_id);
CREATE TRIGGER translation_node_guard BEFORE INSERT ON translations BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM nodes WHERE id=NEW.node_id AND trash_id IS NULL AND kind!='folder')
    THEN RAISE(ABORT,'NODE_UNAVAILABLE') END);
END;
CREATE TRIGGER translation_body_guard BEFORE UPDATE OF body_blob_id ON translations WHEN NEW.body_blob_id IS NOT NULL BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.body_blob_id AND state='ready')
    THEN RAISE(ABORT,'FILE_UNAVAILABLE') END);
END;
CREATE TRIGGER translation_body_retained AFTER UPDATE OF body_blob_id ON translations BEGIN
  UPDATE blobs SET draft_until=NULL WHERE id=NEW.body_blob_id;
END;
