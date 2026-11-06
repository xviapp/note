// Everything the public blog shows, kept as one R2 object so visits and
// crawlers never query D1. The app rebuilds it after any change that could
// alter what is public (see refreshesBlog in worker/index.ts) and on each cron
// run; the blog Worker builds it only when it is missing. See docs/blog.md.
import { blogReach } from './blog';
import type { Env } from './types';

export const BLOG_SNAPSHOT_KEY = 'blog/snapshot.json';

export interface BlogSite {
  blog_parent_id: string | null;
  blog_title: string;
  blog_description: string;
  blog_theme: string;
}
export interface BlogPost {
  node_id: string;
  slug: string;
  title: string;
  summary: string;
  version_id: string;
  published_at: number;
  updated_at: number;
  category: string | null;
  object_key: string;
  page: string | null;
}
export interface BlogFile {
  object_key: string;
  name: string;
  mime: string;
}
export interface BlogSnapshot {
  site: BlogSite | null;
  posts: BlogPost[];
  // Only files a post's published body names, by blob ID.
  files: Record<string, BlogFile>;
}

const ONLINE = blogReach('SELECT node_id FROM blog_posts');
// CROSS JOIN fixes the order: from the few posts outward, each step by key.
// D1 keeps no statistics, and other orders scan every note or blob.
const POSTS = `${ONLINE}
  SELECT p.node_id,p.slug,p.title,p.summary,p.version_id,p.published_at,p.updated_at,p.page,t.category,b.object_key
  FROM blog_tree t
  CROSS JOIN blog_posts p ON p.node_id=t.id
  CROSS JOIN nodes n ON n.id=p.node_id AND n.kind='markdown'
  CROSS JOIN versions v ON v.id=p.version_id AND v.node_id=p.node_id
  CROSS JOIN blobs b ON b.id=v.body_blob_id AND b.key_id IS NULL AND b.state='ready'
  ORDER BY p.published_at DESC,p.node_id`;
const FILES = `${ONLINE}
  SELECT DISTINCT b.id,b.object_key,b.name,b.mime
  FROM blog_tree t
  CROSS JOIN blog_posts p ON p.node_id=t.id
  CROSS JOIN version_assets a ON a.version_id=p.version_id
  CROSS JOIN blobs b ON b.id=a.blob_id AND b.key_id IS NULL AND b.state='ready'
  WHERE a.blob_id IN (SELECT value FROM json_each(p.files))`;

export async function buildBlogSnapshot(env: Env): Promise<BlogSnapshot> {
  const [site, posts, files] = await env.DB.batch([
    env.DB.prepare('SELECT blog_parent_id,blog_title,blog_description,blog_theme FROM site WHERE id=1'),
    env.DB.prepare(POSTS),
    env.DB.prepare(FILES),
  ]);
  const siteRow = (site.results[0] as BlogSite | undefined) ?? null;
  if (!siteRow?.blog_parent_id) return { site: siteRow, posts: [], files: {} };
  return {
    site: siteRow,
    posts: posts.results as BlogPost[],
    files: Object.fromEntries(
      (files.results as (BlogFile & { id: string })[]).map(({ id, ...file }) => [id, file]),
    ),
  };
}

async function digest(text: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Writes the snapshot only when it differs from the stored one.
export async function refreshBlog(env: Env): Promise<BlogSnapshot> {
  const snapshot = await buildBlogSnapshot(env);
  const text = JSON.stringify(snapshot),
    hash = await digest(text);
  const stored = await env.FILES.head(BLOG_SNAPSHOT_KEY);
  if (stored?.customMetadata?.hash !== hash)
    await env.FILES.put(BLOG_SNAPSHOT_KEY, text, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { hash },
    });
  return snapshot;
}

export async function readBlogSnapshot(env: Env): Promise<BlogSnapshot> {
  const object = await env.FILES.get(BLOG_SNAPSHOT_KEY);
  if (object) return object.json<BlogSnapshot>();
  return refreshBlog(env);
}
