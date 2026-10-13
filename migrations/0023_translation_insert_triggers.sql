-- Restores insert translations with their body, which only the update triggers covered.
CREATE TRIGGER translation_body_insert_guard BEFORE INSERT ON translations WHEN NEW.body_blob_id IS NOT NULL BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.body_blob_id AND state='ready')
    THEN RAISE(ABORT,'FILE_UNAVAILABLE') END);
END;
CREATE TRIGGER translation_body_inserted AFTER INSERT ON translations WHEN NEW.body_blob_id IS NOT NULL BEGIN
  UPDATE blobs SET draft_until=NULL WHERE id=NEW.body_blob_id;
END;
UPDATE blobs SET draft_until=NULL WHERE id IN (SELECT body_blob_id FROM translations WHERE body_blob_id IS NOT NULL);
