-- A public blog (worker/blog-site.ts) showing notes below one chosen folder.
-- Nothing is public until it has a row in blog_posts, which pins the published
-- version: later saves stay private until the note is published again.
ALTER TABLE site ADD COLUMN blog_parent_id TEXT REFERENCES nodes(id) ON DELETE SET NULL;
ALTER TABLE site ADD COLUMN blog_title TEXT NOT NULL DEFAULT '博客';
ALTER TABLE site ADD COLUMN blog_description TEXT NOT NULL DEFAULT '';
ALTER TABLE site ADD COLUMN blog_url TEXT;
CREATE TRIGGER blog_parent_guard BEFORE UPDATE OF blog_parent_id ON site
  WHEN NEW.blog_parent_id IS NOT NULL BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM nodes WHERE id=NEW.blog_parent_id AND kind='folder' AND trash_id IS NULL)
    THEN RAISE(ABORT,'INVALID_PARENT') END);
END;
CREATE TRIGGER blog_parent_trashed AFTER UPDATE OF trash_id ON nodes
  WHEN NEW.trash_id IS NOT NULL BEGIN
  UPDATE site SET blog_parent_id=NULL WHERE blog_parent_id=NEW.id;
END;

-- The body and files stay referenced through versions and version_assets, so
-- this table holds no blob of its own; saveNote keeps the pinned version.
CREATE TABLE blog_posts (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  -- JSON array: the files the published body names, the only ones served.
  files TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX blog_posts_version ON blog_posts(version_id);
