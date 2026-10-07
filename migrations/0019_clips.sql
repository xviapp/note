-- Quick clips: short pieces of text kept outside the note tree, newest first.
-- A clip is a short field like a title, so its text lives here (sealed-text
-- prefix when encrypted) rather than in R2. The device picks the ID, which
-- makes a resent create harmless.
CREATE TABLE clips (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  -- The key the text is sealed with, NULL for plain text.
  key_id TEXT REFERENCES encryption_keys(id),
  -- The page it was clipped from; a weak link that may outlive the page.
  source_id TEXT,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  created_at INTEGER NOT NULL
);
CREATE INDEX clips_recent ON clips(pinned, created_at DESC, id DESC);

-- New clips are sealed with this key; NULL keeps them in plain text.
ALTER TABLE site ADD COLUMN clip_key_id TEXT REFERENCES encryption_keys(id);
