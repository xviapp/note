-- The journal Android's 今日记 window writes to; NULL means the journal written in most recently.
ALTER TABLE site ADD COLUMN quick_journal_id TEXT REFERENCES nodes(id) ON DELETE SET NULL;
CREATE TRIGGER quick_journal_guard BEFORE UPDATE OF quick_journal_id ON site
  WHEN NEW.quick_journal_id IS NOT NULL BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM journals j JOIN nodes n ON n.id=j.node_id
    WHERE j.node_id=NEW.quick_journal_id AND n.trash_id IS NULL) THEN RAISE(ABORT,'INVALID_JOURNAL') END);
END;
CREATE TRIGGER quick_journal_trashed AFTER UPDATE OF trash_id ON nodes
  WHEN NEW.trash_id IS NOT NULL BEGIN
  UPDATE site SET quick_journal_id=NULL WHERE quick_journal_id=NEW.id;
END;
