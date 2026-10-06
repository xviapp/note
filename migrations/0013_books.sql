-- A book is a folder with reading details. Its pages are Markdown notes below
-- it (the photo plus the recognized text); discussions sit below a page or the
-- book. The role prompt steers 青藜 for every note inside the book.
CREATE TABLE books (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  author TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'reading' CHECK(status IN ('want','reading','finished')),
  page_count INTEGER NOT NULL DEFAULT 0 CHECK(page_count BETWEEN 0 AND 100000),
  pages_read INTEGER NOT NULL DEFAULT 0 CHECK(pages_read BETWEEN 0 AND 100000),
  role_prompt TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE TRIGGER book_node_guard BEFORE INSERT ON books BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM nodes WHERE id=NEW.node_id AND trash_id IS NULL AND kind='folder')
    THEN RAISE(ABORT,'INVALID_BOOK') END);
END;
