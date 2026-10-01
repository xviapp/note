-- Original attachments and their prepared page images share the private blob
-- store. Retain every reference while its message exists, including in trash.
CREATE TABLE assistant_message_files (
  message_id TEXT NOT NULL REFERENCES assistant_messages(id) ON DELETE CASCADE,
  blob_id TEXT NOT NULL REFERENCES blobs(id) ON DELETE RESTRICT,
  PRIMARY KEY(message_id,blob_id)
);
CREATE INDEX assistant_message_files_blob ON assistant_message_files(blob_id);
CREATE TRIGGER assistant_file_guard BEFORE INSERT ON assistant_message_files BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.blob_id AND state='ready')
    THEN RAISE(ABORT,'FILE_UNAVAILABLE') END);
END;
CREATE TRIGGER assistant_file_retained AFTER INSERT ON assistant_message_files BEGIN
  UPDATE blobs SET draft_until=NULL WHERE id=NEW.blob_id;
END;
