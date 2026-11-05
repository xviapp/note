import {
  BLOG_DESCRIPTION_LIMIT,
  BLOG_SLUG,
  BLOG_SLUG_LIMIT,
  BLOG_TITLE_LIMIT,
  blogExcerpt,
  blogFiles,
  blogSlug,
} from '../shared/blog';
import type { BlogNoteStatus, BlogPostInfo, BlogSettings } from '../shared/types';
import { AppError, idValue, integer, textValue } from './http';
import { getNode, KEY_SQL, nodePath, NOT_DISCUSSION } from './library';
import { readText } from './storage';
import type { Env } from './types';

// What visitors may reach: the blog folder and everything below it that is
// neither trashed, encrypted nor a book discussion. Every public read starts
// here, so moving, trashing or encrypting takes a post offline at once. A
// sealed folder is not entered at all, even for a 'none' note inside it, so
// its title never becomes a category.
export const BLOG_TREE = `WITH RECURSIVE blog_tree(id,category,depth) AS (
  SELECT n.id,NULL,0 FROM site s JOIN nodes n ON n.id=s.blog_parent_id
    WHERE s.id=1 AND n.trash_id IS NULL AND ${KEY_SQL('n')} IS NULL
  UNION ALL
  SELECT c.id,CASE WHEN t.depth=0 AND c.kind='folder' THEN c.title ELSE t.category END,t.depth+1
    FROM nodes c JOIN blog_tree t ON c.parent_id=t.id
    WHERE t.depth<200 AND c.trash_id IS NULL AND (c.encryption IS NULL OR c.encryption='none') AND ${NOT_DISCUSSION('c')}
)`;

export const postPath = (slug: string) => `/posts/${encodeURIComponent(slug)}`;

interface SettingsRow {
  id: string | null;
  blog_title: string;
  blog_description: string;
  blog_url: string | null;
}

export async function blogSettings(env: Env): Promise<BlogSettings> {
  const row = await env.DB.prepare(
    'SELECT n.id,s.blog_title,s.blog_description,s.blog_url FROM site s LEFT JOIN nodes n ON n.id=s.blog_parent_id AND n.trash_id IS NULL WHERE s.id=1',
  ).first<SettingsRow>();
  const parentId = row?.id ?? null;
  return {
    parentId,
    breadcrumbs: parentId ? (await nodePath(env, parentId)).map(({ id, title }) => ({ id, title })) : [],
    title: row?.blog_title ?? '',
    description: row?.blog_description ?? '',
    url: row?.blog_url ?? null,
  };
}

function blogUrl(value: unknown): string | null {
  if (value === null || value === '') return null;
  const text = textValue(value, '博客地址', 200).trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    throw new AppError(400, '博客地址不正确。');
  }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username)
    throw new AppError(400, '博客地址应是 https 开头的域名，例如 https://blog.example.com。');
  return url.origin;
}

export async function saveBlogSettings(env: Env, data: Record<string, unknown>): Promise<BlogSettings> {
  const parent = data.parentId === null ? null : idValue(data.parentId);
  if (parent) {
    const node = await getNode(env, parent);
    if (node.kind !== 'folder') throw new AppError(400, '博客目录需要是一个文件夹。');
    if (node.key_id) throw new AppError(400, '加密的文件夹不能作为博客目录。');
  }
  const title = textValue(data.title, '博客名称', BLOG_TITLE_LIMIT).trim();
  if (!title) throw new AppError(400, '请填写博客名称。');
  const description = textValue(data.description ?? '', '博客简介', BLOG_DESCRIPTION_LIMIT, true).trim();
  await env.DB.prepare(
    'UPDATE site SET blog_parent_id=?,blog_title=?,blog_description=?,blog_url=? WHERE id=1',
  )
    .bind(parent, title, description, blogUrl(data.url ?? null))
    .run();
  return blogSettings(env);
}

interface PostRow {
  node_id: string;
  slug: string;
  title: string;
  published_at: number;
  updated_at: number;
  version_id: string;
  current_version_id: string | null;
  online: number;
}
const POST_ROWS = `${BLOG_TREE}
  SELECT p.node_id,p.slug,p.title,p.published_at,p.updated_at,p.version_id,n.current_version_id,
    (t.id IS NOT NULL AND n.kind='markdown' AND b.key_id IS NULL AND b.state='ready') online
  FROM blog_posts p
  JOIN nodes n ON n.id=p.node_id
  JOIN versions v ON v.id=p.version_id
  JOIN blobs b ON b.id=v.body_blob_id
  LEFT JOIN blog_tree t ON t.id=p.node_id`;
const postInfo = (row: PostRow, base: string | null): BlogPostInfo => ({
  nodeId: row.node_id,
  slug: row.slug,
  title: row.title,
  publishedAt: row.published_at,
  updatedAt: row.updated_at,
  online: !!row.online,
  outdated: row.version_id !== row.current_version_id,
  url: base ? base + postPath(row.slug) : null,
});
const baseUrl = async (env: Env) =>
  (await env.DB.prepare('SELECT blog_url FROM site WHERE id=1').first<{ blog_url: string | null }>())?.blog_url ?? null;

export async function blogPosts(env: Env): Promise<{ posts: BlogPostInfo[] }> {
  const [rows, base] = await Promise.all([
    env.DB.prepare(`${POST_ROWS} ORDER BY p.published_at DESC,p.node_id`).all<PostRow>(),
    baseUrl(env),
  ]);
  return { posts: rows.results.map((row) => postInfo(row, base)) };
}

export async function blogStatus(env: Env, id: string): Promise<BlogNoteStatus> {
  const node = await getNode(env, id);
  const [settings, inTree, post, base] = await Promise.all([
    env.DB.prepare('SELECT blog_parent_id FROM site WHERE id=1').first<{ blog_parent_id: string | null }>(),
    env.DB.prepare(`${BLOG_TREE} SELECT 1 FROM blog_tree WHERE id=? AND depth>0`).bind(id).first(),
    env.DB.prepare(`${POST_ROWS} WHERE p.node_id=?`).bind(id).first<PostRow>(),
    baseUrl(env),
  ]);
  return {
    enabled: !!settings?.blog_parent_id,
    eligible: !!inTree && node.kind === 'markdown' && !node.key_id,
    suggestedSlug: blogSlug(node.title),
    post: post ? postInfo(post, base) : null,
  };
}

// Publishes the note as the author saw it: `revision` is what the dialog was
// showing, so a save from elsewhere is not made public unseen.
export async function publishPost(env: Env, id: string, data: Record<string, unknown>): Promise<BlogNoteStatus> {
  const node = await getNode(env, id);
  if (node.revision !== integer(data.revision, '版本号'))
    throw new AppError(409, '这篇笔记已在其他页面更新，请刷新后再发布。', 'VERSION_CONFLICT');
  const status = await blogStatus(env, id);
  if (!status.enabled) throw new AppError(400, '请先在设置中选择博客目录。');
  if (!status.eligible) throw new AppError(400, '只有博客目录下未加密的 Markdown 笔记可以发布。', 'BLOG_NOT_ELIGIBLE');
  const version = await env.DB.prepare(
    'SELECT v.id,v.body_blob_id FROM versions v JOIN blobs b ON b.id=v.body_blob_id WHERE v.id=? AND b.key_id IS NULL',
  )
    .bind(node.current_version_id)
    .first<{ id: string; body_blob_id: string }>();
  if (!version) throw new AppError(409, '这篇笔记还没有可发布的正文。');
  const chosen = data.slug === undefined || data.slug === '' ? null : textValue(data.slug, '链接', BLOG_SLUG_LIMIT).trim();
  if (chosen !== null && !BLOG_SLUG.test(chosen))
    throw new AppError(400, '链接只能包含文字、数字和连字符。');
  const content = await readText(env, version.body_blob_id);
  const slug = chosen ?? status.post?.slug ?? (status.suggestedSlug || `post-${id.slice(0, 8).toLowerCase()}`);
  const now = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO blog_posts(node_id,version_id,slug,title,summary,files,published_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(node_id) DO UPDATE SET version_id=excluded.version_id,slug=excluded.slug,title=excluded.title,
         summary=excluded.summary,files=excluded.files,updated_at=excluded.updated_at`,
    )
      .bind(id, version.id, slug, node.title, blogExcerpt(content, node.title), JSON.stringify(blogFiles(content)), now, now)
      .run();
  } catch (error) {
    if (/UNIQUE constraint failed: blog_posts\.slug/.test(String(error)))
      throw new AppError(409, '这个链接已被另一篇文章使用，请换一个。', 'BLOG_SLUG_TAKEN');
    throw error;
  }
  return blogStatus(env, id);
}

export async function unpublishPost(env: Env, id: string): Promise<{ ok: true }> {
  await env.DB.prepare('DELETE FROM blog_posts WHERE node_id=?').bind(id).run();
  return { ok: true };
}
