ALTER TABLE nodes ADD COLUMN arxiv_id TEXT
  CHECK(arxiv_id IS NULL OR kind='link');

DROP TRIGGER version_guard;
CREATE TRIGGER version_guard BEFORE INSERT ON versions BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM nodes WHERE id=NEW.node_id AND trash_id IS NULL
    AND revision=NEW.sequence-1 AND (kind IN ('markdown','text') OR (kind='link' AND arxiv_id IS NOT NULL)))
    THEN RAISE(ABORT,'VERSION_CONFLICT') END);
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.body_blob_id AND state='ready')
    THEN RAISE(ABORT,'FILE_UNAVAILABLE') END);
END;
