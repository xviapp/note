-- Local encryption. A content key is generated on a device and stored here only
-- wrapped by a key derived from its password; `check_value` lets the server
-- verify a key sent with an AI request without being able to unwrap it.
CREATE TABLE encryption_keys (
  id TEXT PRIMARY KEY,
  salt TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  wrapped TEXT NOT NULL,
  check_value TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- NULL inherits from the parent, 'none' stores the subtree in plain text, and
-- a key ID encrypts it with that key. The nearest set ancestor wins.
ALTER TABLE nodes ADD COLUMN encryption TEXT;
-- The key an object was encrypted with, NULL for plain text. Objects keep
-- their key when a node moves; re-encrypting replaces them.
ALTER TABLE blobs ADD COLUMN key_id TEXT;

CREATE TRIGGER node_encryption_insert BEFORE INSERT ON nodes
WHEN NEW.encryption IS NOT NULL AND NEW.encryption!='none' BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM encryption_keys WHERE id=NEW.encryption)
    THEN RAISE(ABORT,'ENCRYPTION_KEY_UNAVAILABLE') END);
END;
CREATE TRIGGER node_encryption_update BEFORE UPDATE OF encryption ON nodes
WHEN NEW.encryption IS NOT NULL AND NEW.encryption!='none' BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM encryption_keys WHERE id=NEW.encryption)
    THEN RAISE(ABORT,'ENCRYPTION_KEY_UNAVAILABLE') END);
END;
