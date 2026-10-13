-- Unencrypted note bodies as plain text, for full-text search (worker/note-text.ts).
-- Derived from the current version: backups leave it out and cleanup refills it.
CREATE TABLE note_text (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL,
  body TEXT NOT NULL
);
-- Trigram tokens match any substring of three or more characters, Chinese included.
CREATE VIRTUAL TABLE note_text_index USING fts5(body, content='note_text', content_rowid='rowid', tokenize='trigram');
CREATE TRIGGER note_text_inserted AFTER INSERT ON note_text BEGIN
  INSERT INTO note_text_index(rowid,body) VALUES(NEW.rowid,NEW.body);
END;
CREATE TRIGGER note_text_deleted AFTER DELETE ON note_text BEGIN
  INSERT INTO note_text_index(note_text_index,rowid,body) VALUES('delete',OLD.rowid,OLD.body);
END;
CREATE TRIGGER note_text_updated AFTER UPDATE OF body ON note_text BEGIN
  INSERT INTO note_text_index(note_text_index,rowid,body) VALUES('delete',OLD.rowid,OLD.body);
  INSERT INTO note_text_index(rowid,body) VALUES(NEW.rowid,NEW.body);
END;
