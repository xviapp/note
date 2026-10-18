-- An export downloads each file as it was when the backup was taken
-- (worker/backups.ts): the object it named then, not one re-encrypted since.
ALTER TABLE backup_files ADD COLUMN object_key TEXT;
CREATE INDEX backup_files_object ON backup_files(object_key);
-- Objects replaced while an export still needed them; cleanup deletes each
-- once no backup names it.
CREATE TABLE retired_objects (
  object_key TEXT PRIMARY KEY,
  retired_at INTEGER NOT NULL
);
