-- Highlights and notes on a file: one document per file, kept in R2.
-- The blob holds {"annotations": [...]}.
CREATE TABLE annotations (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  body_blob_id TEXT NOT NULL REFERENCES blobs(id) ON DELETE RESTRICT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX annotations_body ON annotations(body_blob_id);
-- Same guards as paper_translations: a live file, a ready blob, and a
-- referenced blob leaves its upload window so cleanup keys off references alone.
CREATE TRIGGER annotation_node_guard BEFORE INSERT ON annotations BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM nodes WHERE id=NEW.node_id AND trash_id IS NULL AND kind!='folder')
    THEN RAISE(ABORT,'NODE_UNAVAILABLE') END);
END;
CREATE TRIGGER annotation_body_insert_guard BEFORE INSERT ON annotations BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.body_blob_id AND state='ready')
    THEN RAISE(ABORT,'FILE_UNAVAILABLE') END);
END;
CREATE TRIGGER annotation_body_guard BEFORE UPDATE OF body_blob_id ON annotations BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.body_blob_id AND state='ready')
    THEN RAISE(ABORT,'FILE_UNAVAILABLE') END);
END;
CREATE TRIGGER annotation_inserted AFTER INSERT ON annotations BEGIN
  UPDATE blobs SET draft_until=NULL WHERE id=NEW.body_blob_id;
END;
CREATE TRIGGER annotation_retained AFTER UPDATE OF body_blob_id ON annotations BEGIN
  UPDATE blobs SET draft_until=NULL WHERE id=NEW.body_blob_id;
END;
