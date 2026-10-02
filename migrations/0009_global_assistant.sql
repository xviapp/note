-- Rebuild the conversation tables together to preserve messages and attachments.
CREATE TABLE migration_saved_assistant_threads AS SELECT * FROM assistant_threads;
CREATE TABLE migration_saved_assistant_messages AS SELECT * FROM assistant_messages;
CREATE TABLE migration_saved_assistant_message_files AS SELECT * FROM assistant_message_files;
DROP TABLE assistant_message_files;
DROP TABLE assistant_messages;
DROP TABLE assistant_threads;
CREATE TABLE assistant_threads (
  node_id TEXT PRIMARY KEY,
  active_request TEXT,
  locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE assistant_messages (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  node_id TEXT NOT NULL REFERENCES assistant_threads(node_id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  status TEXT NOT NULL CHECK(status IN ('pending','completed','interrupted','failed')),
  body_blob_id TEXT REFERENCES blobs(id) ON DELETE RESTRICT,
  image_blob_id TEXT REFERENCES blobs(id) ON DELETE RESTRICT,
  exported_node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(node_id,request_id,role)
);
CREATE INDEX assistant_messages_node ON assistant_messages(node_id,sequence);
CREATE INDEX assistant_messages_body ON assistant_messages(body_blob_id);
CREATE INDEX assistant_messages_image ON assistant_messages(image_blob_id);
CREATE TABLE assistant_message_files (
  message_id TEXT NOT NULL REFERENCES assistant_messages(id) ON DELETE CASCADE,
  blob_id TEXT NOT NULL REFERENCES blobs(id) ON DELETE RESTRICT,
  PRIMARY KEY(message_id,blob_id)
);
CREATE INDEX assistant_message_files_blob ON assistant_message_files(blob_id);
INSERT INTO assistant_threads SELECT * FROM migration_saved_assistant_threads;
DROP TABLE migration_saved_assistant_threads;
INSERT INTO assistant_messages SELECT * FROM migration_saved_assistant_messages;
DROP TABLE migration_saved_assistant_messages;
INSERT INTO assistant_message_files SELECT * FROM migration_saved_assistant_message_files;
DROP TABLE migration_saved_assistant_message_files;
CREATE TRIGGER assistant_message_guard BEFORE INSERT ON assistant_messages BEGIN
  SELECT (CASE WHEN NEW.node_id!='qingli-global' AND NOT EXISTS(SELECT 1 FROM nodes WHERE id=NEW.node_id AND trash_id IS NULL)
    THEN RAISE(ABORT,'NODE_UNAVAILABLE') END);
  SELECT (CASE WHEN NEW.body_blob_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.body_blob_id AND state='ready')
    THEN RAISE(ABORT,'FILE_UNAVAILABLE') END);
  SELECT (CASE WHEN NEW.image_blob_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.image_blob_id AND state='ready')
    THEN RAISE(ABORT,'FILE_UNAVAILABLE') END);
END;
CREATE TRIGGER assistant_body_guard BEFORE UPDATE OF body_blob_id ON assistant_messages WHEN NEW.body_blob_id IS NOT NULL BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.body_blob_id AND state='ready')
    THEN RAISE(ABORT,'FILE_UNAVAILABLE') END);
END;
CREATE TRIGGER assistant_message_retained AFTER INSERT ON assistant_messages BEGIN
  UPDATE blobs SET draft_until=NULL WHERE id=NEW.body_blob_id OR id=NEW.image_blob_id;
END;
CREATE TRIGGER assistant_body_retained AFTER UPDATE OF body_blob_id ON assistant_messages BEGIN
  UPDATE blobs SET draft_until=NULL WHERE id=NEW.body_blob_id;
END;

CREATE TRIGGER assistant_file_guard BEFORE INSERT ON assistant_message_files BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM blobs WHERE id=NEW.blob_id AND state='ready')
    THEN RAISE(ABORT,'FILE_UNAVAILABLE') END);
END;
CREATE TRIGGER assistant_file_retained AFTER INSERT ON assistant_message_files BEGIN
  UPDATE blobs SET draft_until=NULL WHERE id=NEW.blob_id;
END;

CREATE TRIGGER assistant_thread_guard BEFORE INSERT ON assistant_threads
WHEN NEW.node_id!='qingli-global' BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM nodes WHERE id=NEW.node_id AND trash_id IS NULL)
    THEN RAISE(ABORT,'NODE_UNAVAILABLE') END);
END;
CREATE TRIGGER assistant_thread_delete AFTER DELETE ON nodes BEGIN
  DELETE FROM assistant_threads WHERE node_id=OLD.id;
END;
