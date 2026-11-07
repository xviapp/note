import {
  BLOG_DESCRIPTION_LIMIT,
  BLOG_SLUG,
  BLOG_SLUG_LIMIT,
  BLOG_SUMMARY_LIMIT,
  BLOG_THEMES,
  BLOG_TITLE_LIMIT,
  blogExcerpt,
  blogFiles,
  blogPagePath,
  blogSlug,
  DEFAULT_BLOG_THEME,
} from '../shared/blog';
import type { BlogCandidate, BlogNoteStatus, BlogPostInfo, BlogSettings, BlogSummarySource, NoteNode } from '../shared/types';
import { generateSummary, summaryWorthGenerating } from './blog-summary';
import { AppError, idValue, integer, textValue } from './http';
import { getNode, KEY_SQL, nodePath, NOT_DISCUSSION } from './library';
import { readText } from './storage';
import type { Env } from './types';

// What visitors may reach: the blog folder and everything below it that is
// neither trashed, encrypted nor a book discussion. A sealed folder is not
// entered at all, even for a 'none' note inside it, so its title never becomes
// a category. Walking the whole folder reads every note in it, so only the
// editor's list of candidates uses this; what visitors see (the snapshot) and
// the editor's online flags use blogReach() below. Change the two together.
export const BLOG_TREE = `WITH RECURSIVE blog_tree(id,category,depth) AS (
  SELECT n.id,NULL,0 FROM site s JOIN nodes n ON n.id=s.blog_parent_id
    WHERE s.id=1 AND +n.trash_id IS NULL AND ${KEY_SQL('n')} IS NULL
  UNION ALL
  SELECT c.id,CASE WHEN t.depth=0 AND c.kind='folder' THEN c.title ELSE t.category END,t.depth+1
    FROM nodes c JOIN blog_tree t ON c.parent_id=t.id
    WHERE t.depth<200 AND +c.trash_id IS NULL AND (c.encryption IS NULL OR c.encryption='none') AND ${NOT_DISCUSSION('c')}
)`;
// The same rule as BLOG_TREE, checked upward from the notes `starts` selects:
// a `blog_tree(id,category,depth)` holding those of them BLOG_TREE would reach
// below the folder. Reads only their ancestors, so a visit costs rows per post,
// not per note in the folder. D1 keeps no table statistics, so the CTEs are
// materialized and the unary + hides the trash_id index: otherwise SQLite may
// start from every live note and read them all.
export const blogReach = (starts: string) => `WITH RECURSIVE blog_root(id) AS MATERIALIZED (
  SELECT n.id FROM site s JOIN nodes n ON n.id=s.blog_parent_id
    WHERE s.id=1 AND +n.trash_id IS NULL AND ${KEY_SQL('n')} IS NULL
), blog_up(start,id,parent_id,kind,title,child_kind,child_title,depth) AS (
  SELECT n.id,n.id,n.parent_id,n.kind,n.title,NULL,NULL,0 FROM nodes n
    WHERE n.id IN (${starts}) AND +n.trash_id IS NULL AND (n.encryption IS NULL OR n.encryption='none') AND ${NOT_DISCUSSION('n')}
  UNION ALL
  SELECT u.start,a.id,a.parent_id,a.kind,a.title,u.kind,u.title,u.depth+1
    FROM blog_up u JOIN nodes a ON a.id=u.parent_id
    WHERE u.depth<200 AND u.id NOT IN (SELECT id FROM blog_root) AND a.trash_id IS NULL
      AND (a.id IN (SELECT id FROM blog_root) OR ((a.encryption IS NULL OR a.encryption='none') AND ${NOT_DISCUSSION('a')}))
), blog_tree(id,category,depth) AS MATERIALIZED (
  SELECT u.start,CASE WHEN u.child_kind='folder' THEN u.child_title END,u.depth
    FROM blog_up u JOIN blog_root r ON r.id=u.id WHERE u.depth>0
)`;

export const postPath = (slug: string) => `/posts/${encodeURIComponent(slug)}`;
// Where a post lives: a page's own address, or under /posts.
export const publicPath = (post: { slug: string; page: string | null }) =>
  (post.page && blogPagePath(post.page)) || postPath(post.slug);

interface SettingsRow {
  id: string | null;
  blog_title: string;
  blog_description: string;
  blog_url: string | null;
  blog_theme: string;
}

export async function blogSettings(env: Env): Promise<BlogSettings> {
  const [row, pages] = await Promise.all([
    env.DB.prepare(
      'SELECT n.id,s.blog_title,s.blog_description,s.blog_url,s.blog_theme FROM site s LEFT JOIN nodes n ON n.id=s.blog_parent_id AND n.trash_id IS NULL WHERE s.id=1',
    ).first<SettingsRow>(),
    pageRows(env),
  ]);
  const parentId = row?.id ?? null;
  return {
    parentId,
    breadcrumbs: parentId ? (await nodePath(env, parentId)).map(({ id, title }) => ({ id, title })) : [],
    title: row?.blog_title ?? '',
    description: row?.blog_description ?? '',
    url: row?.blog_url ?? null,
    theme: row?.blog_theme ?? DEFAULT_BLOG_THEME,
    pages: Object.fromEntries(pages.map((page) => [page.page, page.node_id])),
  };
}

const pageRows = async (env: Env) =>
  (await env.DB.prepare('SELECT node_id,page FROM blog_posts WHERE page IS NOT NULL').all<{ node_id: string; page: string }>())
    .results;

// The notes a page can show: what could be published right now.
export async function blogCandidates(env: Env): Promise<{ notes: BlogCandidate[] }> {
  const rows = await env.DB.prepare(
    `${BLOG_TREE} SELECT n.id,n.title,t.category FROM blog_tree t JOIN nodes n ON n.id=t.id
     WHERE t.depth>0 AND n.kind='markdown' ORDER BY t.category IS NOT NULL,t.category,n.title LIMIT 1000`,
  ).all<BlogCandidate>();
  return { notes: rows.results };
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
  const theme = data.theme ?? (await blogSettings(env)).theme;
  if (!BLOG_THEMES.some((item) => item.value === theme)) throw new AppError(400, '没有这个主题。');
  await env.DB.prepare(
    'UPDATE site SET blog_parent_id=?,blog_title=?,blog_description=?,blog_url=?,blog_theme=? WHERE id=1',
  )
    .bind(parent, title, description, blogUrl(data.url ?? null), theme)
    .run();
  if (data.pages !== undefined) await assignPages(env, data.pages);
  return blogSettings(env);
}

// `pages` holds only what changed: a note already on a page may have left the
// folder, and that must not stop the rest of the form from saving. A chosen note
// that was never published goes public here; one already published stays at its
// pinned version.
async function assignPages(env: Env, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, '页面设置不正确。');
  const changes = Object.entries(value as Record<string, unknown>).map(([key, id]) => {
    if (!blogPagePath(key)) throw new AppError(400, '页面设置不正确。');
    return [key, id === null ? null : idValue(id)] as const;
  });
  if (!changes.length) return;
  const assigned = new Map((await pageRows(env)).map((row) => [row.page, row.node_id]));
  for (const [key, id] of changes) {
    if (id) assigned.set(key, id);
    else assigned.delete(key);
  }
  if (new Set(assigned.values()).size !== assigned.size) throw new AppError(400, '一篇笔记只能对应一个页面。');
  for (const [, id] of changes) {
    if (!id) continue;
    const status = await blogStatus(env, id);
    if (status.post) continue;
    if (!status.eligible) throw new AppError(400, '页面只能选择博客目录下未加密的 Markdown 笔记。', 'BLOG_NOT_ELIGIBLE');
    await publishCurrent(env, await getNode(env, id), await freeSlug(env, id, status.suggestedSlug));
  }
  await env.DB.batch(
    changes.flatMap(([key, id]) => [
      env.DB.prepare('UPDATE blog_posts SET page=NULL WHERE page=?').bind(key),
      ...(id ? [env.DB.prepare('UPDATE blog_posts SET page=? WHERE node_id=?').bind(key, id)] : []),
    ]),
  );
}

async function freeSlug(env: Env, id: string, suggested: string) {
  const fallback = `post-${id.slice(0, 8).toLowerCase()}`;
  if (!suggested) return fallback;
  const taken = await env.DB.prepare('SELECT 1 FROM blog_posts WHERE slug=?').bind(suggested).first();
  return taken ? fallback : suggested;
}

interface PostRow {
  node_id: string;
  slug: string;
  title: string;
  summary: string;
  summary_source: BlogSummarySource;
  published_at: number;
  updated_at: number;
  version_id: string;
  current_version_id: string | null;
  online: number;
  page: string | null;
}
const POST_ROWS = `${blogReach('SELECT node_id FROM blog_posts')}
  SELECT p.node_id,p.slug,p.title,p.summary,p.summary_source,p.published_at,p.updated_at,p.version_id,p.page,n.current_version_id,
    (t.id IS NOT NULL AND n.kind='markdown' AND b.key_id IS NULL AND b.state='ready') online
  FROM blog_posts p
  JOIN nodes n ON n.id=p.node_id
  JOIN versions v ON v.id=p.version_id AND v.node_id=p.node_id
  JOIN blobs b ON b.id=v.body_blob_id
  LEFT JOIN blog_tree t ON t.id=p.node_id`;
const postInfo = (row: PostRow, base: string | null): BlogPostInfo => ({
  nodeId: row.node_id,
  slug: row.slug,
  title: row.title,
  summary: row.summary,
  summarySource: row.summary_source,
  publishedAt: row.published_at,
  updatedAt: row.updated_at,
  online: !!row.online,
  outdated: row.version_id !== row.current_version_id,
  url: base ? base + publicPath(row) : null,
  page: row.page,
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
    env.DB.prepare(`${blogReach('SELECT ?')} SELECT 1 FROM blog_tree WHERE id=? AND depth>0`).bind(id, id).first(),
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
  const chosen = data.slug === undefined || data.slug === '' ? null : textValue(data.slug, '链接', BLOG_SLUG_LIMIT).trim();
  if (chosen !== null && !BLOG_SLUG.test(chosen))
    throw new AppError(400, '链接只能包含文字、数字和连字符。');
  // An edited summary sent with the publish is the author's, so no call is made.
  const summary = data.summary === undefined ? undefined : summaryInput(data.summary);
  await publishCurrent(
    env,
    node,
    chosen ?? status.post?.slug ?? (status.suggestedSlug || `post-${id.slice(0, 8).toLowerCase()}`),
    { summarize: true, summary },
  );
  return blogStatus(env, id);
}

const slugTaken = () => new AppError(409, '这个链接已被另一篇文章使用，请换一个。', 'BLOG_SLUG_TAKEN');

interface PublishOptions {
  // Ask 青藜 for a summary when the body is new (publishPost only).
  summarize?: boolean;
  // The author's summary from the dialog: '' goes back to the excerpt.
  summary?: string;
}

async function publishCurrent(env: Env, node: NoteNode, slug: string, options: PublishOptions = {}) {
  const version = await env.DB.prepare(
    'SELECT v.id,v.body_blob_id FROM versions v JOIN blobs b ON b.id=v.body_blob_id WHERE v.id=? AND b.key_id IS NULL',
  )
    .bind(node.current_version_id)
    .first<{ id: string; body_blob_id: string }>();
  if (!version) throw new AppError(409, '这篇笔记还没有可发布的正文。');
  // Before the paid call, so a taken link costs nothing. The constraint below
  // still decides a race.
  if (await env.DB.prepare('SELECT 1 FROM blog_posts WHERE slug=? AND node_id<>?').bind(slug, node.id).first())
    throw slugTaken();
  const content = await readText(env, version.body_blob_id);
  const summary = await summaryFor(env, node, version.body_blob_id, content, options);
  const now = Date.now();
  let written: D1Result;
  try {
    // The summary call can take seconds. Write only if the note is still the
    // version read above and unencrypted: encrypting it meanwhile deleted the
    // row (forgetSubtree), which must not come back. A manual summary saved
    // meanwhile wins over a generated one.
    written = await env.DB.prepare(
      `INSERT INTO blog_posts(node_id,version_id,slug,title,summary,summary_source,files,published_at,updated_at)
       SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(
         SELECT 1 FROM nodes n WHERE n.id=? AND n.current_version_id=? AND n.trash_id IS NULL AND ${KEY_SQL('n')} IS NULL)
       ON CONFLICT(node_id) DO UPDATE SET version_id=excluded.version_id,slug=excluded.slug,title=excluded.title,
         summary=CASE WHEN blog_posts.summary_source='manual' AND excluded.summary_source<>'manual' AND NOT ? THEN blog_posts.summary ELSE excluded.summary END,
         summary_source=CASE WHEN blog_posts.summary_source='manual' AND excluded.summary_source<>'manual' AND NOT ? THEN 'manual' ELSE excluded.summary_source END,
         files=excluded.files,updated_at=excluded.updated_at`,
    )
      .bind(
        node.id,
        version.id,
        slug,
        node.title,
        summary.text,
        summary.source,
        JSON.stringify(blogFiles(content)),
        now,
        now,
        node.id,
        version.id,
        options.summary === undefined ? 0 : 1,
        options.summary === undefined ? 0 : 1,
      )
      .run();
  } catch (error) {
    if (/UNIQUE constraint failed: blog_posts\.slug/.test(String(error))) throw slugTaken();
    throw error;
  }
  if (!written.meta.changes)
    throw new AppError(409, '这篇笔记刚刚有了变化，请刷新后再发布。', 'VERSION_CONFLICT');
}

// The summary a publish should store. The same body keeps what it has (a new
// version may only change attachments), so only new text costs a call, and a
// hand-written one stays until the author replaces it. Pages are not listed,
// so they make do with the excerpt, and a failed call must not stop the publish.
async function summaryFor(
  env: Env,
  node: NoteNode,
  bodyId: string,
  content: string,
  options: PublishOptions,
): Promise<{ text: string; source: BlogSummarySource }> {
  const excerpt = () => ({ text: blogExcerpt(content, node.title), source: 'excerpt' as const });
  if (options.summary !== undefined) return options.summary ? { text: options.summary, source: 'manual' } : excerpt();
  const published = await env.DB.prepare(
    `SELECT p.summary,p.summary_source,p.page,v.body_blob_id FROM blog_posts p
     LEFT JOIN versions v ON v.id=p.version_id WHERE p.node_id=?`,
  )
    .bind(node.id)
    .first<{ summary: string; summary_source: BlogSummarySource; page: string | null; body_blob_id: string | null }>();
  if (published && (published.summary_source === 'manual' || published.body_blob_id === bodyId))
    return { text: published.summary, source: published.summary_source };
  if (!options.summarize || published?.page || !summaryWorthGenerating(content, node.title)) return excerpt();
  try {
    return { text: await generateSummary(env, node.title, content), source: 'ai' };
  } catch (error) {
    // Unconfigured is a choice; anything else (a revoked key, a bug) is logged.
    if (!(error instanceof AppError && error.code === 'AI_NOT_CONFIGURED'))
      console.error('Blog summary failed', error instanceof Error ? error.message : String(error));
    return excerpt();
  }
}

const summaryInput = (value: unknown) =>
  textValue(value, '摘要', BLOG_SUMMARY_LIMIT, true).replace(/\s+/g, ' ').trim();

async function publishedBody(env: Env, id: string) {
  const row = await env.DB.prepare(
    `SELECT p.title,p.version_id,v.body_blob_id FROM blog_posts p JOIN versions v ON v.id=p.version_id
     JOIN blobs b ON b.id=v.body_blob_id WHERE p.node_id=? AND b.key_id IS NULL`,
  )
    .bind(id)
    .first<{ title: string; version_id: string; body_blob_id: string }>();
  if (!row) throw new AppError(404, '这篇笔记没有发布。');
  return { title: row.title, versionId: row.version_id, content: await readText(env, row.body_blob_id) };
}

// The article itself is unchanged, so updated_at stays: readers see no new
// "updated" date, and the blog keeps its rendered posts. A summary derived from
// the body names the version it describes, and is refused if that changed.
async function storeSummary(env: Env, id: string, summary: string, source: BlogSummarySource, versionId?: string) {
  const result = await env.DB.prepare(
    `UPDATE blog_posts SET summary=?,summary_source=? WHERE node_id=?${versionId ? ' AND version_id=?' : ''}`,
  )
    .bind(summary, source, id, ...(versionId ? [versionId] : []))
    .run();
  if (!result.meta.changes)
    throw versionId
      ? new AppError(409, '文章刚刚更新过，请重试。', 'VERSION_CONFLICT')
      : new AppError(404, '这篇笔记没有发布。');
  return blogStatus(env, id);
}

// The author's own summary; left empty, it goes back to the body's opening.
export async function saveBlogSummary(env: Env, id: string, data: Record<string, unknown>): Promise<BlogNoteStatus> {
  const summary = summaryInput(data.summary);
  if (summary) return storeSummary(env, id, summary, 'manual');
  const { title, versionId, content } = await publishedBody(env, id);
  return storeSummary(env, id, blogExcerpt(content, title), 'excerpt', versionId);
}

// Asked for by hand, so a failure is reported instead of falling back. Reads the
// published version: the summary must describe what visitors can read.
export async function regenerateBlogSummary(env: Env, id: string): Promise<BlogNoteStatus> {
  const { title, versionId, content } = await publishedBody(env, id);
  if (!blogExcerpt(content, title)) throw new AppError(400, '这篇文章没有可以概括的文字。');
  return storeSummary(env, id, await generateSummary(env, title, content), 'ai', versionId);
}

export async function unpublishPost(env: Env, id: string): Promise<{ ok: true }> {
  await env.DB.prepare('DELETE FROM blog_posts WHERE node_id=?').bind(id).run();
  return { ok: true };
}
