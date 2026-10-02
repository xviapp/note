ALTER TABLE nodes ADD COLUMN icon_emoji TEXT
  CHECK(icon_emoji IS NULL OR (kind='folder' AND length(icon_emoji) BETWEEN 1 AND 64));
ALTER TABLE nodes ADD COLUMN icon_blob_id TEXT REFERENCES blobs(id) ON DELETE RESTRICT
  CHECK(icon_blob_id IS NULL OR (kind='folder' AND icon_emoji IS NULL));
CREATE INDEX nodes_icon_blob ON nodes(icon_blob_id) WHERE icon_blob_id IS NOT NULL;

CREATE TRIGGER node_icon_insert BEFORE INSERT ON nodes WHEN NEW.icon_blob_id IS NOT NULL BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.icon_blob_id AND state='ready')
    THEN RAISE(ABORT,'FILE_UNAVAILABLE') END);
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.icon_blob_id
    AND mime IN ('image/png','image/jpeg','image/gif','image/webp','image/avif') AND size<=131072)
    THEN RAISE(ABORT,'INVALID_FOLDER_ICON') END);
END;
CREATE TRIGGER node_icon_update BEFORE UPDATE OF icon_blob_id ON nodes WHEN NEW.icon_blob_id IS NOT NULL BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.icon_blob_id AND state='ready')
    THEN RAISE(ABORT,'FILE_UNAVAILABLE') END);
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.icon_blob_id
    AND mime IN ('image/png','image/jpeg','image/gif','image/webp','image/avif') AND size<=131072)
    THEN RAISE(ABORT,'INVALID_FOLDER_ICON') END);
END;
CREATE TRIGGER node_icon_retained_insert AFTER INSERT ON nodes WHEN NEW.icon_blob_id IS NOT NULL BEGIN
  UPDATE blobs SET draft_until=NULL WHERE id=NEW.icon_blob_id;
END;
CREATE TRIGGER node_icon_retained_update AFTER UPDATE OF icon_blob_id ON nodes WHEN NEW.icon_blob_id IS NOT NULL BEGIN
  UPDATE blobs SET draft_until=NULL WHERE id=NEW.icon_blob_id;
END;

ALTER TABLE site ADD COLUMN share_parent_id TEXT REFERENCES nodes(id) ON DELETE SET NULL;
CREATE TRIGGER share_parent_guard BEFORE UPDATE OF share_parent_id ON site
  WHEN NEW.share_parent_id IS NOT NULL BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM nodes WHERE id=NEW.share_parent_id AND trash_id IS NULL)
    THEN RAISE(ABORT,'INVALID_PARENT') END);
END;
CREATE TRIGGER share_parent_trashed AFTER UPDATE OF trash_id ON nodes
  WHEN NEW.trash_id IS NOT NULL BEGIN
  UPDATE site SET share_parent_id=NULL WHERE share_parent_id=NEW.id;
END;
