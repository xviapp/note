-- A journal is a folder whose notes are one per day. Entries live in year and
-- month folders below it; this table, not their titles, says which day each
-- note is, so renaming or moving an entry within the journal keeps its day.
CREATE TABLE journals (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE
);
CREATE TABLE journal_entries (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  journal_id TEXT NOT NULL REFERENCES journals(node_id) ON DELETE CASCADE,
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  created_at INTEGER NOT NULL,
  UNIQUE (journal_id, date)
);
CREATE INDEX journal_entries_date ON journal_entries(journal_id, date);

CREATE TRIGGER journal_guard BEFORE INSERT ON journals BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM nodes WHERE id=NEW.node_id AND kind='folder')
    OR EXISTS(SELECT 1 FROM books WHERE node_id=NEW.node_id)
    OR EXISTS(SELECT 1 FROM projects WHERE node_id=NEW.node_id)
    OR EXISTS(SELECT 1 FROM node_references WHERE node_id=NEW.node_id)
    THEN RAISE(ABORT,'INVALID_JOURNAL') END);
END;
CREATE TRIGGER journal_entry_guard BEFORE INSERT ON journal_entries BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM nodes WHERE id=NEW.node_id AND kind='markdown')
    THEN RAISE(ABORT,'INVALID_JOURNAL') END);
END;
