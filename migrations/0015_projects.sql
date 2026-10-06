-- Project folders and references reuse the existing node tree. Metadata is a
-- rebuildable cache of the current Markdown version, never a second source.
CREATE TABLE projects (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE
);
CREATE TABLE node_references (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  target_id TEXT REFERENCES nodes(id) ON DELETE SET NULL
);
CREATE INDEX node_references_target ON node_references(target_id);
ALTER TABLE nodes ADD COLUMN metadata_title TEXT;
ALTER TABLE nodes ADD COLUMN metadata_status TEXT;
ALTER TABLE nodes ADD COLUMN metadata_excerpt TEXT;
ALTER TABLE nodes ADD COLUMN metadata_version_id TEXT;

CREATE TRIGGER project_guard BEFORE INSERT ON projects BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM nodes WHERE id=NEW.node_id AND kind='folder')
    OR EXISTS(SELECT 1 FROM books WHERE node_id=NEW.node_id)
    OR EXISTS(SELECT 1 FROM node_references WHERE node_id=NEW.node_id)
    THEN RAISE(ABORT,'INVALID_PROJECT') END);
END;
CREATE TRIGGER reference_guard BEFORE INSERT ON node_references BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM nodes WHERE id=NEW.node_id AND kind='folder')
    OR EXISTS(SELECT 1 FROM projects WHERE node_id=NEW.node_id)
    OR EXISTS(SELECT 1 FROM books WHERE node_id=NEW.node_id)
    OR EXISTS(SELECT 1 FROM nodes WHERE parent_id=NEW.node_id)
    THEN RAISE(ABORT,'INVALID_REFERENCE') END);
END;
CREATE TRIGGER reference_parent_insert BEFORE INSERT ON nodes WHEN NEW.parent_id IS NOT NULL BEGIN
  SELECT (CASE WHEN EXISTS(SELECT 1 FROM node_references WHERE node_id=NEW.parent_id)
    THEN RAISE(ABORT,'INVALID_PARENT') END);
END;
CREATE TRIGGER reference_parent_update BEFORE UPDATE OF parent_id ON nodes WHEN NEW.parent_id IS NOT NULL BEGIN
  SELECT (CASE WHEN EXISTS(SELECT 1 FROM node_references WHERE node_id=NEW.parent_id)
    THEN RAISE(ABORT,'INVALID_PARENT') END);
END;
