CREATE TABLE ai_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  encrypted_key TEXT NOT NULL
);

CREATE TABLE assistant_threads (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
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
CREATE TRIGGER assistant_message_guard BEFORE INSERT ON assistant_messages BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM nodes WHERE id=NEW.node_id AND trash_id IS NULL)
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

-- Any file can own Markdown notes produced by its assistant.
DROP TRIGGER node_parent_insert;
DROP TRIGGER node_parent_update;
CREATE TRIGGER node_parent_insert BEFORE INSERT ON nodes WHEN NEW.parent_id IS NOT NULL BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM nodes WHERE id=NEW.parent_id AND trash_id IS NULL)
    THEN RAISE(ABORT,'INVALID_PARENT') END);
END;
CREATE TRIGGER node_parent_update BEFORE UPDATE OF parent_id ON nodes WHEN NEW.parent_id IS NOT NULL BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM nodes WHERE id=NEW.parent_id AND trash_id IS NULL)
    THEN RAISE(ABORT,'INVALID_PARENT') END);
  SELECT (CASE WHEN NEW.parent_id IN (
    WITH RECURSIVE subtree(id) AS (SELECT OLD.id UNION ALL SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id=s.id)
    SELECT id FROM subtree
  ) THEN RAISE(ABORT,'TREE_CYCLE') END);
END;
