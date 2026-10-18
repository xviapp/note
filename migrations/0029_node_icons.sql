-- Any entry can have an icon, not only folders (worker/library.ts nodeIcon).
-- The columns from 0008 allow folders only, and SQLite cannot relax a column
-- CHECK without rebuilding nodes (whose implicit delete would cascade), so
-- icons move to these columns; icon_emoji and icon_blob_id stay NULL.
ALTER TABLE nodes ADD COLUMN icon_glyph TEXT
  CHECK(icon_glyph IS NULL OR length(icon_glyph) BETWEEN 1 AND 64);
ALTER TABLE nodes ADD COLUMN icon_file_id TEXT REFERENCES blobs(id) ON DELETE RESTRICT
  CHECK(icon_file_id IS NULL OR icon_glyph IS NULL);
CREATE INDEX nodes_icon_file ON nodes(icon_file_id) WHERE icon_file_id IS NOT NULL;

CREATE TRIGGER node_icon_file_insert BEFORE INSERT ON nodes WHEN NEW.icon_file_id IS NOT NULL BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.icon_file_id AND state='ready')
    THEN RAISE(ABORT,'FILE_UNAVAILABLE') END);
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.icon_file_id
    AND mime IN ('image/png','image/jpeg','image/gif','image/webp','image/avif') AND size<=131072)
    THEN RAISE(ABORT,'INVALID_FOLDER_ICON') END);
END;
CREATE TRIGGER node_icon_file_update BEFORE UPDATE OF icon_file_id ON nodes WHEN NEW.icon_file_id IS NOT NULL BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.icon_file_id AND state='ready')
    THEN RAISE(ABORT,'FILE_UNAVAILABLE') END);
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.icon_file_id
    AND mime IN ('image/png','image/jpeg','image/gif','image/webp','image/avif') AND size<=131072)
    THEN RAISE(ABORT,'INVALID_FOLDER_ICON') END);
END;
CREATE TRIGGER node_icon_file_retained_insert AFTER INSERT ON nodes WHEN NEW.icon_file_id IS NOT NULL BEGIN
  UPDATE blobs SET draft_until=NULL WHERE id=NEW.icon_file_id;
END;
CREATE TRIGGER node_icon_file_retained_update AFTER UPDATE OF icon_file_id ON nodes WHEN NEW.icon_file_id IS NOT NULL BEGIN
  UPDATE blobs SET draft_until=NULL WHERE id=NEW.icon_file_id;
END;

UPDATE nodes SET icon_glyph=icon_emoji,icon_file_id=icon_blob_id,icon_emoji=NULL,icon_blob_id=NULL
  WHERE icon_emoji IS NOT NULL OR icon_blob_id IS NOT NULL;
