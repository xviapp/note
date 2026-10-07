-- A clip may carry one image, kept in R2 like any file. The clip names the
-- blob; deleting or dropping the clip leaves the blob to cleanup.
ALTER TABLE clips ADD COLUMN blob_id TEXT REFERENCES blobs(id);
CREATE INDEX clips_blob ON clips(blob_id);

CREATE TRIGGER clip_blob_guard BEFORE INSERT ON clips WHEN NEW.blob_id IS NOT NULL BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.blob_id AND state='ready')
    THEN RAISE(ABORT,'FILE_UNAVAILABLE') END);
END;
CREATE TRIGGER clip_blob_retained AFTER INSERT ON clips WHEN NEW.blob_id IS NOT NULL BEGIN
  UPDATE blobs SET draft_until=NULL WHERE id=NEW.blob_id;
END;
