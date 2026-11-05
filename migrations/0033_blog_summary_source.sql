-- Where a post's summary came from: cut from the body ('excerpt'), written by
-- 青藜 ('ai') or by the author ('manual'). A manual one survives later updates.
ALTER TABLE blog_posts ADD COLUMN summary_source TEXT NOT NULL DEFAULT 'excerpt';
