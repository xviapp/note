// Everything the public blog shows, kept as one R2 object so visits and
// crawlers never query D1. The app rebuilds it after any change that could
// alter what is public (see refreshesBlog in worker/index.ts) and on each cron
// run; the blog Worker builds it only when it is missing. See docs/blog.md.
import { digest } from './auth';
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
  const site =
    (await env.DB.prepare('SELECT blog_parent_id,blog_title,blog_description,blog_theme FROM site WHERE id=1').first<BlogSite>()) ??
    null;
  // No blog: nothing to walk.
  if (!site?.blog_parent_id) return { site, posts: [], files: {} };
  const [posts, files] = await env.DB.batch([env.DB.prepare(POSTS), env.DB.prepare(FILES)]);
  return {
    site,
    posts: posts.results as BlogPost[],
    files: Object.fromEntries(
      (files.results as (BlogFile & { id: string })[]).map(({ id, ...file }) => [id, file]),
    ),
  };
}

// Whether a public post serves this file, so replacing its object (re-sealing)
// changes what the blog may hand out.
export async function blogServesFile(env: Env, blobId: string): Promise<boolean> {
  return !!(await env.DB.prepare(
    `SELECT 1 FROM version_assets a JOIN blog_posts p ON p.version_id=a.version_id
     WHERE a.blob_id=? AND a.blob_id IN (SELECT value FROM json_each(p.files)) LIMIT 1`,
  )
    .bind(blobId)
    .first());
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Writes the snapshot only when it differs from the stored one. Two requests
// may rebuild at once and R2 takes one write per second per key, so the write
// is conditional on the object seen before reading D1: after a conflict or a
// refusal it waits, reads D1 again (the newest state wins) and retries.
export async function refreshBlog(env: Env, attempts = 3): Promise<BlogSnapshot> {
  for (let attempt = 1; ; attempt++) {
    const stored = await env.FILES.head(BLOG_SNAPSHOT_KEY);
    const snapshot = await buildBlogSnapshot(env);
    const text = JSON.stringify(snapshot),
      hash = await digest(text);
    if (stored?.customMetadata?.hash === hash) return snapshot;
    let failure: unknown = null;
    try {
      const written = await env.FILES.put(BLOG_SNAPSHOT_KEY, text, {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { hash },
        ...(stored ? { onlyIf: { etagMatches: stored.etag } } : {}),
      });
      if (written) return snapshot;
      failure = new Error('Blog snapshot changed while it was rebuilt');
    } catch (error) {
      failure = error;
    }
    if (attempt >= attempts) throw failure;
    await pause(1100);
  }
}

// The blog Worker keeps the parsed snapshot and asks R2 only whether it
// changed, so an image or a feed request does not download it again.
let cached: { etag: string; snapshot: BlogSnapshot } | null = null;

export async function readBlogSnapshot(env: Env): Promise<BlogSnapshot> {
  const object = await env.FILES.get(
    BLOG_SNAPSHOT_KEY,
    cached ? { onlyIf: { etagDoesNotMatch: cached.etag } } : undefined,
  );
  if (object && 'body' in object) {
    const snapshot = await object.json<BlogSnapshot>();
    cached = { etag: object.etag, snapshot };
    return snapshot;
  }
  if (object && cached) return cached.snapshot;
  // Missing (a first deploy): built from D1. Visitors arriving together race
  // for the write, and a lost race still serves what was built.
  cached = null;
  try {
    return await refreshBlog(env, 1);
  } catch {
    return buildBlogSnapshot(env);
  }
}
