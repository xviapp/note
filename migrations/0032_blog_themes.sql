-- The blog's look, and the post shown at a fixed address (shared/blog.ts) instead
-- of in the list. A page is a blog_posts row, so it stays pinned to the version
-- published and goes offline with the note like any other post.
ALTER TABLE site ADD COLUMN blog_theme TEXT NOT NULL DEFAULT 'paper';
ALTER TABLE blog_posts ADD COLUMN page TEXT;
CREATE UNIQUE INDEX blog_posts_page ON blog_posts(page) WHERE page IS NOT NULL;
