-- A short copy of each file's highlights and notes for search: one line per
-- annotation, built from the R2 document on every save.
ALTER TABLE annotations ADD COLUMN search_text TEXT NOT NULL DEFAULT '';
