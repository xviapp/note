-- The blog's sections (BLOG_PAGES in shared/blog.ts): the first-level folders
-- listed as articles and as projects, and the section shown at /. A published
-- note outside both folders that no page shows is not public. The folders are
-- kept when they move or are trashed: they list nothing until they are back.
ALTER TABLE site ADD COLUMN blog_articles_id TEXT REFERENCES nodes(id) ON DELETE SET NULL;
ALTER TABLE site ADD COLUMN blog_projects_id TEXT REFERENCES nodes(id) ON DELETE SET NULL;
ALTER TABLE site ADD COLUMN blog_home TEXT NOT NULL DEFAULT 'articles';
-- Home and projects are no longer notes. Those posts stay published and are
-- shown again once they are in a listed folder or on another page.
UPDATE blog_posts SET page=NULL WHERE page IN ('home','projects');
