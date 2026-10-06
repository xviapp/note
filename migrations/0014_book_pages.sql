-- A photographed page of a book: its number, and 青藜's summary and questions
-- for the version of the text they were written from.
CREATE TABLE book_pages (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  page INTEGER CHECK(page IS NULL OR page BETWEEN 1 AND 100000),
  summary TEXT NOT NULL DEFAULT '',
  questions TEXT NOT NULL DEFAULT '[]',
  -- The page version the summary was written from; another version makes it stale.
  source_version_id TEXT,
  -- This page's reading note, where discussions are summarized.
  note_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX book_pages_note ON book_pages(note_id);

-- A discussion is a note below a page whose 青藜 thread holds the conversation.
-- It stays out of the tree, lists and search; the page lists it instead.
CREATE TABLE book_discussions (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

-- The section a discussion was last summarized into, to update it in place and
-- to notice when it was edited by hand since.
CREATE TABLE book_note_sections (
  discussion_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The book's collected reading note.
ALTER TABLE books ADD COLUMN note_id TEXT REFERENCES nodes(id) ON DELETE SET NULL;

-- Pages photographed before this version: notes titled "第 N 页" right below a book.
INSERT INTO book_pages(node_id,page,updated_at)
SELECT n.id, CAST(trim(substr(n.title, 2, length(n.title) - 2)) AS INTEGER), n.updated_at
FROM nodes n JOIN books b ON b.node_id=n.parent_id
WHERE n.kind='markdown' AND n.title GLOB '第 [0-9]* 页'
  AND CAST(trim(substr(n.title, 2, length(n.title) - 2)) AS INTEGER) BETWEEN 1 AND 100000;
