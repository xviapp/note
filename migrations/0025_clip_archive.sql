-- Archived clips are retained independently of the rolling clipboard limit.
ALTER TABLE clips ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1));
CREATE INDEX clips_archive_recent ON clips(archived, pinned, created_at DESC, id DESC);
