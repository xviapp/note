// The public blog, deployed as its own Worker (wrangler.blog.jsonc) on its own
// domain. It only reads, has no sign-in and exposes no /api route, so nothing
// private is reachable from that domain. See docs/blog.md.
import { BLOG_PAGES, BLOG_THEMES, blogPagePath, DEFAULT_BLOG_THEME } from '../shared/blog';
import { publicPath } from './blog';
import { renderPost } from './blog-render';
import { type BlogFile, type BlogPost as Post, type BlogSite as Site, readBlogSnapshot } from './blog-snapshot';
import { SEALED_MAGIC } from '../shared/encryption';
import type { Env } from './types';

// Bump when renderPost's output changes for the same Markdown.
const RENDER_VERSION = 1;
const RENDER_TTL_SECONDS = 86_400;
const INLINE_IMAGE = /^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/;

// Fonts a page needs at once: a formula stays blank until its font arrives, and
// is laid out again when it does. Only what the page uses, or browsers warn.
const THEME_FONT = 'special-elite-latin-400-normal';
const MATH_FONTS: [RegExp, string][] = [
  [/class="katex/, 'KaTeX_Main-Regular'],
  [/\bmathnormal\b/, 'KaTeX_Math-Italic'],
  [/\bboldsymbol\b/, 'KaTeX_Math-BoldItalic'],
  [/\bmathbf\b/, 'KaTeX_Main-Bold'],
  [/\b(?:mathbb|amsrm)\b/, 'KaTeX_AMS-Regular'],
  [/\bmathcal\b/, 'KaTeX_Caligraphic-Regular'],
  [/\bdelim-size1\b|\bsize1\b/, 'KaTeX_Size1-Regular'],
  [/\bsize2\b/, 'KaTeX_Size2-Regular'],
  [/\bsize3\b/, 'KaTeX_Size3-Regular'],
  [/\bdelim-size4\b|\bsize4\b/, 'KaTeX_Size4-Regular'],
];
const mathFonts = (html: string) => MATH_FONTS.filter(([used]) => used.test(html)).map(([, font]) => font);

const CSP = [
  "default-src 'none'",
  "img-src 'self' https: data:",
  // KaTeX and Mermaid position their output with inline styles.
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  // Cloudflare Web Analytics, which the zone injects into every page.
  "script-src 'self' https://static.cloudflareinsights.com",
  "connect-src 'self' https://cloudflareinsights.com",
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

// The menu: the post list, then each page that has a note online.
function navigation(posts: Post[], current: string): string {
  const has = new Set(posts.map((post) => post.page));
  const link = (href: string, label: string) =>
    `<a href="${href}"${href === current ? ' aria-current="page"' : ''}>${label}</a>`;
  return [
    ...(has.has('home') ? [link('/', '首页')] : []),
    link(has.has('home') ? '/blog' : '/', '文章'),
    ...BLOG_PAGES.filter((item) => item.key !== 'home' && has.has(item.key)).map((item) => link(item.path, item.label)),
    '<a href="/feed.xml">RSS</a>',
  ].join('');
}

function page(
  request: Request,
  site: Site,
  head: { title: string; description?: string; canonical: string; article?: boolean; mermaid?: boolean; fonts?: string[] },
  main: string,
  posts: Post[] = [],
  status = 200,
): Response {
  const description = head.description ?? site.blog_description;
  const title = escapeHtml(head.title),
    name = escapeHtml(site.blog_title);
  const theme = BLOG_THEMES.find((item) => item.value === site.blog_theme) ?? BLOG_THEMES[0];
  const sidebar = theme.value !== DEFAULT_BLOG_THEME;
  const fonts = [...(sidebar ? [THEME_FONT] : []), ...(head.fonts ?? [])];
  return respond(
    request,
    `<!doctype html>
<html lang="zh-CN" data-theme="${theme.value}" data-layout="${sidebar ? 'sidebar' : 'column'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="${theme.scheme}">
<title>${title}</title>
${description ? `<meta name="description" content="${escapeHtml(description)}">` : ''}
<link rel="canonical" href="${escapeHtml(head.canonical)}">
<link rel="alternate" type="application/rss+xml" title="${name}" href="/feed.xml">
<meta property="og:site_name" content="${name}">
<meta property="og:title" content="${title}">
<meta property="og:type" content="${head.article ? 'article' : 'website'}">
<meta property="og:url" content="${escapeHtml(head.canonical)}">
${description ? `<meta property="og:description" content="${escapeHtml(description)}">` : ''}
${fonts.map((font) => `<link rel="preload" href="/assets/fonts/${font}.woff2" as="font" type="font/woff2" crossorigin>`).join('\n')}
<link rel="stylesheet" href="/assets/blog.css">
${head.mermaid ? '<script type="module" src="/assets/blog.js"></script>' : ''}
</head>
<body>
<div class="site-shell">
<header class="site-header">
<a class="site-mark" href="/" aria-hidden="true" tabindex="-1">${escapeHtml(Array.from(site.blog_title)[0] ?? '')}</a>
<a class="site-name" href="/">${name}</a>
<nav class="site-nav" aria-label="页面">${navigation(posts, new URL(request.url).pathname)}</nav>
</header>
<main>${main}</main>
</div>
<footer class="site-footer">${name} © ${new Date().getUTCFullYear()}</footer>
</body>
</html>`,
    'text/html',
    status,
  );
}

function notFound(request: Request, site: Site, url: URL, posts: Post[] = [], message = '这个页面不存在或已下线。') {
  return page(
    request,
    site,
    { title: `未找到 · ${site.blog_title}`, canonical: url.origin + url.pathname },
    `<article class="empty"><h1>未找到</h1><p>${escapeHtml(message)}</p><p><a href="/">返回首页</a></p></article>`,
    posts,
    404,
  );
}

function postList(posts: Post[]): string {
  if (!posts.length) return '<p class="empty">还没有文章。</p>';
  return `<ol class="post-list">${posts
    .map(
      (post) => `<li>
<h2><a href="${publicPath(post)}">${escapeHtml(post.title)}</a></h2>
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
async function renderedPost(env: Env, url: URL, post: Post, posts: Post[]): Promise<string | null> {
  const pages = posts.flatMap((item) => (item.page ? [`${item.page}.${item.node_id}`] : [])).sort().join();
  const stamp = encodeURIComponent(`${posts.length}-${Math.max(...posts.map((item) => item.updated_at))}-${pages}`);
  const key = new Request(`${url.origin}/__rendered/${RENDER_VERSION}/${post.version_id}/${stamp}`);
  const cache = typeof caches === 'undefined' ? null : (caches as unknown as { default: Cache }).default;
  const hit = await cache?.match(key).catch(() => undefined);
  if (hit) return hit.text();
  const object = await env.FILES.get(post.object_key);
  if (!object) throw new Error('Post body is missing');
  const hrefs = new Map(posts.map((item) => [item.node_id, publicPath(item)]));
  const markdown = await object.text();
  // Sealed since the snapshot was written: the next refresh drops the post.
  if (markdown.startsWith(SEALED_MAGIC)) return null;
  const html = renderPost(markdown, post.title, (id) => hrefs.get(id) ?? null);
  await cache
    ?.put(key, new Response(html, { headers: { 'cache-control': `public, max-age=${RENDER_TTL_SECONDS}` } }))
    .catch(() => {});
  return html;
}

async function serveFile(env: Env, request: Request, file: BlogFile | undefined): Promise<Response | null> {
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
  const items = posts.filter((post) => !post.page).slice(0, 30).map((post) => {
    const link = xml(url.origin + publicPath(post));
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
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${
      posts.some((post) => post.page === 'home') ? `<url><loc>${url.origin}/blog</loc></url>` : `<url><loc>${url.origin}/</loc></url>`
    }${posts
      .map((post) => `<url><loc>${url.origin}${publicPath(post)}</loc><lastmod>${day(post.updated_at)}</lastmod></url>`)
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
  // Visits read only the snapshot; D1 is not touched (worker/blog-snapshot.ts).
  const { site, posts, files } = await readBlogSnapshot(env);
  if (!site?.blog_parent_id)
    return notFound(
      request,
      site ?? { blog_parent_id: null, blog_title: '博客', blog_description: '', blog_theme: DEFAULT_BLOG_THEME },
      url,
      [],
      '博客尚未开放。',
    );
  const file = path.match(/^\/files\/([a-zA-Z0-9_-]{1,80})$/);
  if (file)
    return (await serveFile(env, request, Object.hasOwn(files, file[1]) ? files[file[1]] : undefined)) ?? notFound(request, site, url);
  const listed = posts.filter((post) => !post.page);
  const home = posts.find((post) => post.page === 'home');
  if (path === '/feed.xml') return feed(request, site, url, posts);
  if (path === '/sitemap.xml') return sitemap(request, url, posts);
  const shown = posts.find((post) => post.page && blogPagePath(post.page) === path);
  if (shown) return showPost(request, env, site, url, shown, posts);
  if (path === (home ? '/blog' : '/'))
    return page(
      request,
      site,
      { title: site.blog_title, canonical: url.origin + path },
      `${site.blog_description ? `<p class="site-description">${escapeHtml(site.blog_description)}</p>` : ''}${categoryNav(listed)}${postList(listed)}`,
      posts,
    );
  if (path === '/blog') return Response.redirect(`${url.origin}/`, 301);
  const category = path.match(/^\/category\/([^/]+)$/);
  if (category) {
    const name = decoded(category[1]);
    const inCategory = listed.filter((post) => post.category === name);
    if (!name || !inCategory.length) return notFound(request, site, url, posts);
    return page(
      request,
      site,
      { title: `${name} · ${site.blog_title}`, canonical: url.origin + categoryPath(name) },
      `${categoryNav(listed, name)}${postList(inCategory)}`,
      posts,
    );
  }
  const slug = path.match(/^\/posts\/([^/]+)$/);
  if (slug) {
    const name = decoded(slug[1]);
    const post = posts.find((item) => item.slug === name);
    if (!post) return notFound(request, site, url, posts);
    // Links from before the post became a page keep working.
    if (post.page) return Response.redirect(url.origin + publicPath(post), 301);
    return showPost(request, env, site, url, post, posts);
  }
  return notFound(request, site, url, posts);
}

async function showPost(request: Request, env: Env, site: Site, url: URL, post: Post, posts: Post[]) {
  const html = await renderedPost(env, url, post, posts);
  if (html === null) return notFound(request, site, url, posts);
  const meta = post.page
    ? ''
    : `<p class="post-meta"><time datetime="${day(post.published_at)}">${day(post.published_at)}</time>${
        post.category ? ` · <a href="${categoryPath(post.category)}">${escapeHtml(post.category)}</a>` : ''
      }${day(post.updated_at) !== day(post.published_at) ? ` · 更新于 ${day(post.updated_at)}` : ''}</p>`;
  return page(
    request,
    site,
    {
      title: post.page === 'home' ? site.blog_title : `${post.title} · ${site.blog_title}`,
      description: post.summary,
      canonical: url.origin + publicPath(post),
      article: !post.page,
      mermaid: html.includes('<pre class="mermaid">'),
      fonts: mathFonts(html),
    },
    `<article>
<h1>${escapeHtml(post.title)}</h1>
${meta}
<div class="markdown-body">${html}</div>
</article>`,
    posts,
  );
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
