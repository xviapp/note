-- Book covers are independent of the folder's small custom icon.
ALTER TABLE books ADD COLUMN cover_blob_id TEXT REFERENCES blobs(id) ON DELETE RESTRICT;
CREATE INDEX book_cover_blob ON books(cover_blob_id);
CREATE TRIGGER book_cover_insert_guard BEFORE INSERT ON books WHEN NEW.cover_blob_id IS NOT NULL BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.cover_blob_id AND state='ready')
    THEN RAISE(ABORT,'FILE_UNAVAILABLE') END);
END;
CREATE TRIGGER book_cover_update_guard BEFORE UPDATE OF cover_blob_id ON books WHEN NEW.cover_blob_id IS NOT NULL BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.cover_blob_id AND state='ready')
    THEN RAISE(ABORT,'FILE_UNAVAILABLE') END);
END;
CREATE TRIGGER book_cover_inserted AFTER INSERT ON books BEGIN
  UPDATE blobs SET draft_until=NULL WHERE id=NEW.cover_blob_id;
END;
CREATE TRIGGER book_cover_retained AFTER UPDATE OF cover_blob_id ON books BEGIN
  UPDATE blobs SET draft_until=NULL WHERE id=NEW.cover_blob_id;
END;
