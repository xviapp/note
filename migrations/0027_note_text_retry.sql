-- A body that could not be read is retried later instead of counting as empty
-- (worker/note-text.ts): `attempts` failed reads of this version so far, the
-- next one due at `retry_at`.
ALTER TABLE note_text ADD COLUMN retry_at INTEGER;
ALTER TABLE note_text ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
