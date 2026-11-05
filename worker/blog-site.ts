// The public blog, deployed as its own Worker (wrangler.blog.jsonc) on its own
// domain. It only reads, has no sign-in and exposes no /api route, so nothing
// private is reachable from that domain. See docs/blog.md.
import { BLOG_TREE, postPath } from './blog';
import { renderPost } from './blog-render';
import type { Env } from './types';

interface Site {
  blog_parent_id: string | null;
  blog_title: string;
  blog_description: string;
}
interface Post {
  node_id: string;
  slug: string;
  title: string;
  summary: string;
  version_id: string;
  published_at: number;
  updated_at: number;
  category: string | null;
  object_key: string;
}
const POSTS = `${BLOG_TREE}
  SELECT p.node_id,p.slug,p.title,p.summary,p.version_id,p.published_at,p.updated_at,t.category,b.object_key
  FROM blog_tree t
  JOIN blog_posts p ON p.node_id=t.id
  JOIN nodes n ON n.id=p.node_id AND n.kind='markdown'
  JOIN versions v ON v.id=p.version_id AND v.node_id=p.node_id
  JOIN blobs b ON b.id=v.body_blob_id AND b.key_id IS NULL AND b.state='ready'
  ORDER BY p.published_at DESC,p.node_id`;
// Only a file its post's published body names, whatever else the note holds.
const FILE = `${BLOG_TREE}
  SELECT b.object_key,b.name,b.mime
  FROM blog_tree t
  JOIN blog_posts p ON p.node_id=t.id
  JOIN version_assets a ON a.version_id=p.version_id AND a.blob_id=?
  JOIN blobs b ON b.id=a.blob_id AND b.key_id IS NULL AND b.state='ready'
  WHERE a.blob_id IN (SELECT value FROM json_each(p.files))
  LIMIT 1`;
// Bump when renderPost's output changes for the same Markdown.
const RENDER_VERSION = 1;
const RENDER_TTL_SECONDS = 86_400;
const INLINE_IMAGE = /^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/;

const CSP = [
  "default-src 'none'",
  "img-src 'self' https: data:",
  // KaTeX and Mermaid position their output with inline styles.
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "script-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');
const HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const day = (time: number) => new Date(time).toISOString().slice(0, 10);
const categoryPath = (name: string) => `/category/${encodeURIComponent(name)}`;

function respond(request: Request, body: string, type: string, status = 200): Response {
  return new Response(request.method === 'HEAD' ? null : body, {
    status,
    headers: {
      ...HEADERS,
      'content-type': `${type};charset=utf-8`,
      // Revalidate every time: taking a post offline must not linger in browsers.
      'cache-control': 'public, max-age=0, must-revalidate',
    },
  });
}

function page(
  request: Request,
  site: Site,
  head: { title: string; description?: string; canonical: string; article?: boolean; mermaid?: boolean },
  main: string,
  status = 200,
): Response {
  const description = head.description ?? site.blog_description;
  const title = escapeHtml(head.title),
    name = escapeHtml(site.blog_title);
  return respond(
    request,
    `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
${description ? `<meta name="description" content="${escapeHtml(description)}">` : ''}
<link rel="canonical" href="${escapeHtml(head.canonical)}">
<link rel="alternate" type="application/rss+xml" title="${name}" href="/feed.xml">
<meta property="og:site_name" content="${name}">
<meta property="og:title" content="${title}">
<meta property="og:type" content="${head.article ? 'article' : 'website'}">
<meta property="og:url" content="${escapeHtml(head.canonical)}">
${description ? `<meta property="og:description" content="${escapeHtml(description)}">` : ''}
<link rel="stylesheet" href="/assets/blog.css">
${head.mermaid ? '<script type="module" src="/assets/blog.js"></script>' : ''}
</head>
<body>
<header class="site-header"><a class="site-name" href="/">${name}</a><a class="site-feed" href="/feed.xml">RSS</a></header>
<main>${main}</main>
</body>
</html>`,
    'text/html',
    status,
  );
}

function notFound(request: Request, site: Site, url: URL, message = '这个页面不存在或已下线。') {
  return page(
    request,
    site,
    { title: `未找到 · ${site.blog_title}`, canonical: url.origin + url.pathname },
    `<article class="empty"><h1>未找到</h1><p>${escapeHtml(message)}</p><p><a href="/">返回首页</a></p></article>`,
    404,
  );
}

function postList(posts: Post[]): string {
  if (!posts.length) return '<p class="empty">还没有文章。</p>';
  return `<ol class="post-list">${posts
    .map(
      (post) => `<li>
<h2><a href="${postPath(post.slug)}">${escapeHtml(post.title)}</a></h2>
<p class="post-meta"><time datetime="${day(post.published_at)}">${day(post.published_at)}</time>${
        post.category ? ` · <a href="${categoryPath(post.category)}">${escapeHtml(post.category)}</a>` : ''
      }</p>
${post.summary ? `<p class="post-summary">${escapeHtml(post.summary)}</p>` : ''}
</li>`,
    )
    .join('')}</ol>`;
}

function categoryNav(posts: Post[], active?: string): string {
  const names = [...new Set(posts.map((post) => post.category).filter((name): name is string => !!name))].sort((a, b) =>
    a.localeCompare(b, 'zh-CN'),
  );
  if (!names.length) return '';
  return `<nav class="categories" aria-label="分类">${[
    `<a href="/"${active ? '' : ' aria-current="page"'}>全部</a>`,
    ...names.map(
      (name) =>
        `<a href="${categoryPath(name)}"${name === active ? ' aria-current="page"' : ''}>${escapeHtml(name)}</a>`,
    ),
  ].join('')}</nav>`;
}

// Rendering a long post with formulas can take longer than the CPU a Worker
// gets, so the result is kept. Links to other posts are part of the output,
// hence the stamp of the whole published set. Access checks are never cached.
async function renderedPost(env: Env, url: URL, post: Post, posts: Post[]): Promise<string> {
  const stamp = `${posts.length}-${Math.max(...posts.map((item) => item.updated_at))}`;
  const key = new Request(`${url.origin}/__rendered/${RENDER_VERSION}/${post.version_id}/${stamp}`);
  const cache = typeof caches === 'undefined' ? null : (caches as unknown as { default: Cache }).default;
  const hit = await cache?.match(key).catch(() => undefined);
  if (hit) return hit.text();
  const object = await env.FILES.get(post.object_key);
  if (!object) throw new Error('Post body is missing');
  const hrefs = new Map(posts.map((item) => [item.node_id, postPath(item.slug)]));
  const html = renderPost(await object.text(), post.title, (id) => hrefs.get(id) ?? null);
  await cache
    ?.put(key, new Response(html, { headers: { 'cache-control': `public, max-age=${RENDER_TTL_SECONDS}` } }))
    .catch(() => {});
  return html;
}

async function serveFile(env: Env, request: Request, id: string): Promise<Response | null> {
  const file = await env.DB.prepare(FILE).bind(id).first<{ object_key: string; name: string; mime: string }>();
  if (!file) return null;
  const object =
    request.method === 'HEAD' ? await env.FILES.head(file.object_key) : await env.FILES.get(file.object_key);
  if (!object) return null;
  const inline = INLINE_IMAGE.test(file.mime);
  return new Response(request.method === 'HEAD' ? null : (object as R2ObjectBody).body, {
    headers: {
      'content-type': inline ? file.mime : 'application/octet-stream',
      'content-length': String(object.size),
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'cache-control': 'public, max-age=300',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'x-content-type-options': 'nosniff',
    },
  });
}

function feed(request: Request, site: Site, url: URL, posts: Post[]): Response {
  const xml = (value: string) =>
    value
      // Characters XML 1.0 cannot carry at all.
      // oxlint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  const items = posts.slice(0, 30).map((post) => {
    const link = xml(url.origin + postPath(post.slug));
    return `<item><title>${xml(post.title)}</title><link>${link}</link><guid isPermaLink="false">${xml(post.node_id)}</guid><pubDate>${new Date(post.published_at).toUTCString()}</pubDate><description>${xml(post.summary)}</description></item>`;
  });
  return respond(
    request,
    `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>${xml(site.blog_title)}</title><link>${xml(url.origin)}/</link><description>${xml(site.blog_description || site.blog_title)}</description><language>zh-CN</language>${items.join('')}</channel></rss>`,
    'application/rss+xml',
  );
}

function sitemap(request: Request, url: URL, posts: Post[]): Response {
  return respond(
    request,
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${url.origin}/</loc></url>${posts
      .map((post) => `<url><loc>${url.origin}${postPath(post.slug)}</loc><lastmod>${day(post.updated_at)}</lastmod></url>`)
      .join('')}</urlset>`,
    'application/xml',
  );
}

const decoded = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

export async function handleBlog(request: Request, env: Env): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method))
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  const url = new URL(request.url),
    path = url.pathname;
  if (path === '/robots.txt')
    return respond(request, `User-agent: *\nAllow: /\nSitemap: ${url.origin}/sitemap.xml\n`, 'text/plain');
  const site = await env.DB.prepare(
    'SELECT blog_parent_id,blog_title,blog_description FROM site WHERE id=1',
  ).first<Site>();
  if (!site?.blog_parent_id)
    return notFound(request, site ?? { blog_parent_id: null, blog_title: '博客', blog_description: '' }, url, '博客尚未开放。');
  const file = path.match(/^\/files\/([a-zA-Z0-9_-]{1,80})$/);
  if (file)
    return (await serveFile(env, request, file[1])) ?? notFound(request, site, url);
  const posts = (await env.DB.prepare(POSTS).all<Post>()).results;
  if (path === '/feed.xml') return feed(request, site, url, posts);
  if (path === '/sitemap.xml') return sitemap(request, url, posts);
  if (path === '/')
    return page(
      request,
      site,
      { title: site.blog_title, canonical: `${url.origin}/` },
      `${site.blog_description ? `<p class="site-description">${escapeHtml(site.blog_description)}</p>` : ''}${categoryNav(posts)}${postList(posts)}`,
    );
  const category = path.match(/^\/category\/([^/]+)$/);
  if (category) {
    const name = decoded(category[1]);
    const listed = posts.filter((post) => post.category === name);
    if (!name || !listed.length) return notFound(request, site, url);
    return page(
      request,
      site,
      { title: `${name} · ${site.blog_title}`, canonical: url.origin + categoryPath(name) },
      `${categoryNav(posts, name)}${postList(listed)}`,
    );
  }
  const slug = path.match(/^\/posts\/([^/]+)$/);
  if (slug) {
    const name = decoded(slug[1]);
    const post = posts.find((item) => item.slug === name);
    if (!post) return notFound(request, site, url);
    const html = await renderedPost(env, url, post, posts);
    return page(
      request,
      site,
      {
        title: `${post.title} · ${site.blog_title}`,
        description: post.summary,
        canonical: url.origin + postPath(post.slug),
        article: true,
        mermaid: html.includes('<pre class="mermaid">'),
      },
      `<article>
<h1>${escapeHtml(post.title)}</h1>
<p class="post-meta"><time datetime="${day(post.published_at)}">${day(post.published_at)}</time>${
        post.category ? ` · <a href="${categoryPath(post.category)}">${escapeHtml(post.category)}</a>` : ''
      }${day(post.updated_at) !== day(post.published_at) ? ` · 更新于 ${day(post.updated_at)}` : ''}</p>
<div class="markdown-body">${html}</div>
</article>`,
    );
  }
  return notFound(request, site, url);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleBlog(request, env);
    } catch (error) {
      console.error('Blog request failed', error);
      return new Response('页面暂时无法显示，请稍后重试。', {
        status: 500,
        headers: { ...HEADERS, 'content-type': 'text/plain;charset=utf-8', 'cache-control': 'no-store' },
      });
    }
  },
};
