-- Whole-paper translations: one document per paper and language, kept in R2.
-- The blob holds {"blocks": {<source hash>: <translated text>}}.
CREATE TABLE paper_translations (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_language TEXT NOT NULL,
  body_blob_id TEXT NOT NULL REFERENCES blobs(id) ON DELETE RESTRICT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, target_language)
);
CREATE INDEX paper_translations_body ON paper_translations(body_blob_id);
-- Same guards as translations: a live paper, a ready blob, and a referenced
-- blob leaves its upload window so cleanup keys off references alone.
CREATE TRIGGER paper_translation_node_guard BEFORE INSERT ON paper_translations BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM nodes WHERE id=NEW.node_id AND trash_id IS NULL AND arxiv_id IS NOT NULL)
    THEN RAISE(ABORT,'NODE_UNAVAILABLE') END);
END;
CREATE TRIGGER paper_translation_body_insert_guard BEFORE INSERT ON paper_translations BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.body_blob_id AND state='ready')
    THEN RAISE(ABORT,'FILE_UNAVAILABLE') END);
END;
CREATE TRIGGER paper_translation_body_guard BEFORE UPDATE OF body_blob_id ON paper_translations BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.body_blob_id AND state='ready')
    THEN RAISE(ABORT,'FILE_UNAVAILABLE') END);
END;
CREATE TRIGGER paper_translation_inserted AFTER INSERT ON paper_translations BEGIN
  UPDATE blobs SET draft_until=NULL WHERE id=NEW.body_blob_id;
END;
CREATE TRIGGER paper_translation_retained AFTER UPDATE OF body_blob_id ON paper_translations BEGIN
  UPDATE blobs SET draft_until=NULL WHERE id=NEW.body_blob_id;
END;
