/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, SELF, applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker/types';
import type { BlogNoteStatus, BlogPostInfo, BlogSettings, NoteDetail, NoteNode } from '../shared/types';
import { handleBlog } from '../worker/blog-site';
import { BLOG_SNAPSHOT_KEY, refreshBlog } from '../worker/blog-snapshot';
import { cleanup } from '../worker/recovery';
import { blogExcerpt, blogSlug } from '../shared/blog';
import { preparePassword } from '../shared/password';

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const ORIGIN = 'https://notes.test';
let cookie = '';
const call = (path: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      cookie,
      'content-type': 'application/json',
      'x-idempotency-key': crypto.randomUUID(),
      ...headers,
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
async function ok<T>(path: string, method = 'GET', data?: unknown, headers?: Record<string, string>) {
  const response = await call(path, method, data, headers);
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}
const visit = (path: string, method = 'GET') =>
  handleBlog(new Request(`https://blog.test${path}`, { method }), bindings);
const text = async (path: string) => (await visit(path)).text();

const folder = async (title: string, parentId: string | null = null) =>
  (await ok<NoteNode>('/api/nodes', 'POST', { kind: 'folder', title, parentId })).id;
const note = (title: string, parentId: string | null, content: string) =>
  ok<NoteNode>('/api/nodes', 'POST', { kind: 'markdown', title, parentId, content, attachments: [] });
async function save(id: string, content: string, attachments: string[] = []) {
  const detail = await ok<NoteDetail>(`/api/nodes/${id}`);
  const { token } = await ok<{ token: string }>('/api/edit/unlock', 'POST', { nodeId: id });
  return ok<NoteNode>(
    `/api/nodes/${id}/content`,
    'PUT',
    { content, attachments, revision: detail.revision },
    { 'x-note-edit': token },
  );
}
const publish = (node: NoteNode, slug?: string) =>
  ok<BlogNoteStatus>(`/api/blog/posts/${node.id}`, 'PUT', { revision: node.revision, slug });
const setRoot = (parentId: string | null) =>
  ok<BlogSettings>('/api/blog/settings', 'PUT', { parentId, title: '我的博客', description: '简介', url: 'https://blog.test' });

async function newKey() {
  const keyId = crypto.randomUUID();
  await bindings.DB.prepare(
    "INSERT INTO encryption_keys(id,salt,iterations,wrapped,check_value,created_at) VALUES(?,'s',1,'w','c',1)",
  )
    .bind(keyId)
    .run();
  return keyId;
}

beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await bindings.DB.batch([
    bindings.DB.prepare('DELETE FROM blog_posts'),
    bindings.DB.prepare('DELETE FROM ai_settings'),
    bindings.DB.prepare('UPDATE site SET blog_parent_id=NULL,share_parent_id=NULL WHERE id=1'),
    bindings.DB.prepare('DELETE FROM version_assets'),
    bindings.DB.prepare('UPDATE nodes SET current_version_id=NULL'),
    bindings.DB.prepare('DELETE FROM versions'),
    bindings.DB.prepare('DELETE FROM note_text'),
    bindings.DB.prepare('DELETE FROM nodes'),
    bindings.DB.prepare('DELETE FROM idempotency'),
    bindings.DB.prepare('DELETE FROM blobs'),
    bindings.DB.prepare('DELETE FROM sessions'),
    bindings.DB.prepare('DELETE FROM login_attempts'),
    bindings.DB.prepare(
      'UPDATE site SET password_hash=NULL,password_salt=NULL,auth_epoch=0,quota_bytes=8000000000,allocated_bytes=0 WHERE id=1',
    ),
  ]);
  await bindings.FILES.delete(BLOG_SNAPSHOT_KEY);
  const setup = await SELF.fetch(`${ORIGIN}/api/auth/setup`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({
      token: bindings.SETUP_TOKEN,
      password: await preparePassword('correct horse battery'),
    }),
  });
  cookie = setup.headers.get('set-cookie')!.split(';')[0];
});

describe('blog visibility', () => {
  it('shows nothing until a folder is chosen and a note is published', async () => {
    const root = await folder('博客');
    const draft = await note('草稿标题', root, '# 草稿标题\n\n私密草稿');
    expect((await visit('/')).status).toBe(404);
    await setRoot(root);
    const home = await text('/');
    expect(home).toContain('我的博客');
    expect(home).not.toContain('草稿标题');
    expect((await visit('/posts/草稿标题')).status).toBe(404);
    const status = await publish(draft);
    expect(status.post).toMatchObject({ slug: '草稿标题', online: true, outdated: false });
    expect(await text('/')).toContain('草稿标题');
    const page = await text(`/posts/${encodeURIComponent('草稿标题')}`);
    expect(page).toContain('私密草稿');
    // The leading H1 repeats the page's own heading.
    expect(page.match(/<h1>/g)).toHaveLength(1);
  });

  it('keeps later saves private until published again', async () => {
    const root = await folder('博客');
    await setRoot(root);
    const post = await note('文章', root, '第一版');
    await publish(post);
    const saved = await save(post.id, '尚未发布的第二版');
    expect((await ok<BlogNoteStatus>(`/api/blog/posts/${post.id}`)).post?.outdated).toBe(true);
    expect(await text(`/posts/${encodeURIComponent('文章')}`)).toContain('第一版');
    expect(await text(`/posts/${encodeURIComponent('文章')}`)).not.toContain('第二版');
    await publish(saved);
    expect(await text(`/posts/${encodeURIComponent('文章')}`)).toContain('第二版');
  });

  it('refuses to publish a version the author has not seen', async () => {
    const root = await folder('博客');
    await setRoot(root);
    const post = await note('文章', root, '第一版');
    await save(post.id, '别处保存的版本');
    const response = await call(`/api/blog/posts/${post.id}`, 'PUT', { revision: post.revision });
    expect(response.status).toBe(409);
    expect((await visit(`/posts/${encodeURIComponent('文章')}`)).status).toBe(404);
  });

  it('keeps the published version through more saves than the history holds', async () => {
    const root = await folder('博客');
    await setRoot(root);
    const post = await note('长文', root, '发布的版本');
    await publish(post);
    for (let i = 0; i < 8; i++) await save(post.id, `后来的第 ${i} 版`);
    await cleanup(bindings);
    expect(await text(`/posts/${encodeURIComponent('长文')}`)).toContain('发布的版本');
    const versions = await bindings.DB.prepare('SELECT COUNT(*) count FROM versions WHERE node_id=?')
      .bind(post.id)
      .first<{ count: number }>();
    expect(versions!.count).toBe(7);
    // Once unpublished it is ordinary history again and ages out with the next save.
    await ok(`/api/blog/posts/${post.id}`, 'DELETE');
    await save(post.id, '再后来');
    const after = await bindings.DB.prepare('SELECT COUNT(*) count FROM versions WHERE node_id=?')
      .bind(post.id)
      .first<{ count: number }>();
    expect(after!.count).toBe(6);
  });

  it('goes offline when unpublished, moved out of the folder or trashed', async () => {
    const root = await folder('博客');
    const outside = await folder('私人');
    await setRoot(root);
    const first = await note('甲', root, '甲的正文');
    await publish(first);
    await ok(`/api/blog/posts/${first.id}`, 'DELETE');
    expect((await visit(`/posts/${encodeURIComponent('甲')}`)).status).toBe(404);

    const moved = await publish(await note('乙', root, '乙的正文')).then((status) => status.post!.nodeId);
    const detail = await ok<NoteNode>(`/api/nodes/${moved}`);
    await ok(`/api/nodes/${moved}`, 'PATCH', { revision: detail.revision, parentId: outside });
    expect((await visit(`/posts/${encodeURIComponent('乙')}`)).status).toBe(404);
    expect(await text('/feed.xml')).not.toContain('乙');
    const listed = await ok<{ posts: BlogPostInfo[] }>('/api/blog/posts');
    expect(listed.posts.find((post) => post.nodeId === moved)?.online).toBe(false);

    const trashed = await note('丙', root, '丙的正文');
    await publish(trashed);
    await ok(`/api/nodes/${trashed.id}`, 'DELETE', { count: 1 });
    expect((await visit(`/posts/${encodeURIComponent('丙')}`)).status).toBe(404);
  });

  it('closes the whole blog when its folder is trashed', async () => {
    const root = await folder('博客');
    await setRoot(root);
    await publish(await note('文章', root, '正文'));
    await ok(`/api/nodes/${root}`, 'DELETE', { count: 2 });
    expect((await ok<BlogSettings>('/api/blog/settings')).parentId).toBeNull();
    expect((await visit('/')).status).toBe(404);
  });

  it('drops the post and its stored title when the note becomes encrypted', async () => {
    const root = await folder('博客');
    await setRoot(root);
    const post = await note('将要加密', root, '正文');
    await publish(post);
    const keyId = await newKey();
    await ok(`/api/nodes/${post.id}/encryption`, 'PUT', { encryption: keyId });
    expect((await visit(`/posts/${encodeURIComponent('将要加密')}`)).status).toBe(404);
    expect(
      await bindings.DB.prepare('SELECT 1 FROM blog_posts WHERE node_id=?').bind(post.id).first(),
    ).toBeNull();
    const refused = await call(`/api/blog/posts/${post.id}`, 'PUT', { revision: post.revision });
    expect(refused.status).toBe(400);
  });

  it('never uses an encrypted folder, or enters one inside the blog', async () => {
    const root = await folder('博客');
    await setRoot(root);
    const sealed = await folder('密封分类', root);
    const inner = await note('明文', sealed, '正文');
    const keyId = await newKey();
    await ok(`/api/nodes/${sealed}/encryption`, 'PUT', { encryption: keyId });
    expect((await call('/api/blog/settings', 'PUT', { parentId: sealed, title: '博客' })).status).toBe(400);
    await bindings.DB.prepare("UPDATE nodes SET encryption='none' WHERE id=?").bind(inner.id).run();
    expect((await ok<BlogNoteStatus>(`/api/blog/posts/${inner.id}`)).eligible).toBe(false);
  });

  it('refuses a folder that is not a folder, a bad address and a taken link', async () => {
    const root = await folder('博客');
    const plain = await note('笔记', root, '正文');
    expect((await call('/api/blog/settings', 'PUT', { parentId: plain.id, title: '博客' })).status).toBe(400);
    await setRoot(root);
    expect(
      (await call('/api/blog/settings', 'PUT', { parentId: root, title: '博客', url: 'http://blog.test' })).status,
    ).toBe(400);
    expect((await call('/api/blog/settings', 'PUT', { parentId: root, title: '博客', url: 'https://a.test/x' })).status).toBe(400);
    await publish(plain, 'same');
    const other = await note('另一篇', root, '正文');
    const taken = await call(`/api/blog/posts/${other.id}`, 'PUT', { revision: other.revision, slug: 'same' });
    expect(taken.status).toBe(409);
    expect(((await taken.json()) as { code: string }).code).toBe('BLOG_SLUG_TAKEN');
    const bad = await call(`/api/blog/posts/${other.id}`, 'PUT', { revision: other.revision, slug: 'a/b' });
    expect(bad.status).toBe(400);
  });

  it('is closed to command-line tokens and anonymous requests', async () => {
    const root = await folder('博客');
    await setRoot(root);
    const post = await note('文章', root, '正文');
    const { token } = await ok<{ token: string }>('/api/tokens', 'POST', { name: '电脑', scope: 'write' });
    const byToken = await SELF.fetch(`${ORIGIN}/api/blog/posts/${post.id}`, {
      method: 'PUT',
      headers: { origin: ORIGIN, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ revision: post.revision }),
    });
    expect(byToken.status).toBe(403);
    const anonymous = await SELF.fetch(`${ORIGIN}/api/blog/settings`, { headers: { origin: ORIGIN } });
    expect(anonymous.status).toBe(401);
  });
});

describe('blog files', () => {
  const upload = async (name: string, mime: string, parent?: string) => {
    const response = await SELF.fetch(
      `${ORIGIN}/api/files?name=${encodeURIComponent(name)}&size=12&mime=${encodeURIComponent(mime)}${parent ? `&nodeId=${parent}` : ''}`,
      {
        method: 'POST',
        headers: { origin: ORIGIN, cookie, 'content-type': mime },
        body: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]),
      },
    );
    if (!response.ok) throw new Error(await response.text());
    return ((await response.json()) as { id: string }).id;
  };

  it('serves only the files the published body names', async () => {
    const root = await folder('博客');
    await setRoot(root);
    const shown = await upload('shown.png', 'image/png');
    const hidden = await upload('hidden.png', 'image/png');
    const later = await upload('later.png', 'image/png');
    const post = await note('带图', root, '无图');
    const saved = await save(post.id, `![图](/api/files/${shown})`, [hidden]);
    await publish(saved);
    const page = await text(`/posts/${encodeURIComponent('带图')}`);
    expect(page).toContain(`src="/files/${shown}"`);
    expect(page).not.toContain('/api/files/');

    const image = await visit(`/files/${shown}`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('content-security-policy')).toContain('sandbox');
    // In the note's attachments but never named in the body.
    expect((await visit(`/files/${hidden}`)).status).toBe(404);
    // Added after publishing.
    await save(post.id, `![图](/api/files/${shown}) ![新](/api/files/${later})`);
    expect((await visit(`/files/${later}`)).status).toBe(404);
    // Gone with the post.
    await ok(`/api/blog/posts/${post.id}`, 'DELETE');
    expect((await visit(`/files/${shown}`)).status).toBe(404);
  });
});

describe('blog pages', () => {
  it('renders Markdown safely and links only to public notes', async () => {
    const root = await folder('博客');
    await setRoot(root);
    const target = await note('目标', root, '正文');
    await publish(target, 'target');
    const hidden = await note('未发布', root, '正文');
    const post = await note(
      '<b>标题</b>',
      root,
      [
        '<script>alert(1)</script>',
        `[公开](/n/${target.id}) [私密](/n/${hidden.id}) [坏](javascript:alert(1))`,
        '公式 $E=mc^2$',
        '```mermaid\ngraph TD; A-->B\n```',
      ].join('\n\n'),
    );
    await publish(post, 'unsafe');
    const page = await visit('/posts/unsafe');
    const html = await page.text();
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self' https://static.cloudflareinsights.com");
    expect(html).toContain('&lt;b&gt;标题&lt;/b&gt;');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<a href="/posts/target">公开</a>');
    expect(html).toContain('<span>私密</span>');
    expect(html).not.toContain(hidden.id);
    expect(html).toContain('class="katex"');
    expect(html).toContain('<pre class="mermaid">');
    expect(html).toContain('src="/assets/blog.js"');
    // Pages without a diagram run no script.
    expect(await text('/posts/target')).not.toContain('<script');
  });

  it('lists categories from first-level folders, and offers a feed and sitemap', async () => {
    const root = await folder('博客');
    await setRoot(root);
    const tech = await folder('技术', root);
    await publish(await note('甲 & 乙', tech, '正文一'), 'one');
    await publish(await note('丙', root, '正文二'), 'two');
    const home = await text('/');
    expect(home).toContain(`href="/category/${encodeURIComponent('技术')}"`);
    const category = await text(`/category/${encodeURIComponent('技术')}`);
    expect(category).toContain('/posts/one');
    expect(category).not.toContain('/posts/two');
    const feed = await visit('/feed.xml');
    expect(feed.headers.get('content-type')).toContain('application/rss+xml');
    expect(await feed.text()).toContain('甲 &amp; 乙');
    const map = await text('/sitemap.xml');
    expect(map).toContain('https://blog.test/posts/one');
    expect(await text('/robots.txt')).toContain('Sitemap: https://blog.test/sitemap.xml');
  });

  it('serves visits from the snapshot without touching D1', async () => {
    const root = await folder('博客');
    await setRoot(root);
    await publish(await note('静态', root, '正文'), 'static');
    const offline = {
      ...bindings,
      DB: new Proxy(bindings.DB, {
        get() {
          throw new Error('D1 was queried');
        },
      }),
    } as Env;
    const visitOffline = (path: string) => handleBlog(new Request(`https://blog.test${path}`), offline);
    for (const path of ['/', '/posts/static', '/feed.xml', '/sitemap.xml', '/missing'])
      expect([200, 404]).toContain((await visitOffline(path)).status);
    expect(await (await visitOffline('/posts/static')).text()).toContain('正文');
  });

  it('rebuilds the snapshot when a category folder is renamed, and only then', async () => {
    const root = await folder('博客');
    await setRoot(root);
    const tech = await folder('技术', root);
    const post = await note('文章', tech, '正文');
    await publish(post, 'post');
    expect(await text('/')).toContain(encodeURIComponent('技术'));
    const before = await bindings.FILES.head(BLOG_SNAPSHOT_KEY);
    await save(post.id, '新正文');
    expect((await bindings.FILES.head(BLOG_SNAPSHOT_KEY))?.etag).toBe(before?.etag);
    const { revision } = await ok<NoteDetail>(`/api/nodes/${tech}`);
    await ok(`/api/nodes/${tech}`, 'PATCH', { title: '编程', revision });
    expect(await text('/')).toContain(encodeURIComponent('编程'));
  });

  it('only reads: no other methods, and no app routes', async () => {
    const root = await folder('博客');
    await setRoot(root);
    expect((await visit('/', 'POST')).status).toBe(405);
    expect((await visit('/api/nodes')).status).toBe(404);
    expect((await visit('/api/auth/status')).status).toBe(404);
    expect((await visit('/posts/%E0%A4%A')).status).toBe(404);
  });
});

describe('blog themes and pages', () => {
  const settings = (extra: object, parentId: string | null) =>
    call('/api/blog/settings', 'PUT', { parentId, title: '我的博客', description: '简介', url: 'https://blog.test', ...extra });
  const assign = async (parentId: string, pages: Record<string, string | null>) => {
    const response = await settings({ pages }, parentId);
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()) as BlogSettings;
  };

  it('applies a theme, keeps it when not sent, and refuses an unknown one', async () => {
    const root = await folder('博客');
    await setRoot(root);
    expect(await text('/')).toContain('data-theme="paper"');
    expect((await settings({ theme: 'hacking' }, root)).status).toBe(200);
    await setRoot(root);
    const html = await text('/');
    expect(html).toContain('data-theme="hacking"');
    expect(html).toContain('data-layout="sidebar"');
    expect(html).toContain('<meta name="color-scheme" content="dark">');
    expect((await settings({ theme: '<script>' }, root)).status).toBe(400);
    expect(await text('/')).toContain('data-theme="hacking"');
  });

  it('shows a chosen note at its address instead of in the list, feed and categories', async () => {
    const root = await folder('博客');
    await setRoot(root);
    const post = await note('普通文章', root, '普通正文');
    await publish(post, 'plain');
    const about = await note('关于我', root, '自我介绍');
    expect((await ok<{ notes: { id: string }[] }>('/api/blog/candidates')).notes.map(({ id }) => id).sort()).toEqual(
      [about.id, post.id].sort(),
    );
    // Choosing it is what publishes it.
    expect((await visit('/about')).status).toBe(404);
    expect((await assign(root, { about: about.id })).pages).toEqual({ about: about.id });
    const html = await text('/about');
    expect(html).toContain('自我介绍');
    expect(html).toContain('aria-current="page">关于');
    const home = await text('/');
    expect(home).toContain('href="/about"');
    expect(home).toContain('普通文章');
    expect(home).not.toContain('关于我');
    expect(await text('/feed.xml')).not.toContain('关于我');
    expect(await text('/sitemap.xml')).toContain('/about');
    const { slug, url } = (await ok<BlogNoteStatus>(`/api/blog/posts/${about.id}`)).post!;
    expect(url).toBe('https://blog.test/about');
    const moved = await visit(`/posts/${encodeURIComponent(slug)}`);
    expect(moved.status).toBe(301);
    expect(moved.headers.get('location')).toBe('https://blog.test/about');
    // Cleared, it is an ordinary published post again.
    expect((await assign(root, { about: null })).pages).toEqual({});
    expect((await visit('/about')).status).toBe(404);
    expect(await text('/')).toContain('关于我');
  });

  it('moves the post list to /blog when a home page is chosen', async () => {
    const root = await folder('博客');
    await setRoot(root);
    await publish(await note('普通文章', root, '普通正文'), 'plain');
    expect((await visit('/blog')).status).toBe(301);
    const hello = await note('你好', root, '欢迎来到这里');
    await assign(root, { home: hello.id });
    const home = await text('/');
    expect(home).toContain('欢迎来到这里');
    expect(home).not.toContain('普通文章');
    expect(await text('/blog')).toContain('普通文章');
    expect(home).toContain('href="/blog"');
  });

  it('keeps the pinned version of a note that was already published', async () => {
    const root = await folder('博客');
    await setRoot(root);
    const about = await note('关于', root, '已发布的内容');
    await publish(about);
    await save(about.id, '尚未发布的修改');
    await assign(root, { about: about.id });
    const html = await text('/about');
    expect(html).toContain('已发布的内容');
    expect(html).not.toContain('尚未发布的修改');
  });

  it('refuses notes that cannot be public, and leaves nothing published', async () => {
    const root = await folder('博客');
    await setRoot(root);
    const outside = await note('私人笔记', null, '私人内容');
    const refused = await settings({ pages: { about: outside.id } }, root);
    expect(refused.status).toBe(400);
    expect((await ok<BlogNoteStatus>(`/api/blog/posts/${outside.id}`)).post).toBeNull();
    expect(await text('/')).not.toContain('私人笔记');
    expect((await visit('/about')).status).toBe(404);
    const one = await note('一篇', root, '内容');
    expect((await settings({ pages: { about: one.id, resume: one.id } }, root)).status).toBe(400);
    expect((await settings({ pages: { admin: one.id } }, root)).status).toBe(400);
    expect((await ok<BlogNoteStatus>(`/api/blog/posts/${one.id}`)).post).toBeNull();
  });

  it('takes a page offline with its note, and returns it when restored to the folder', async () => {
    const root = await folder('博客');
    await setRoot(root);
    const hello = await note('你好', root, '欢迎来到这里');
    await assign(root, { home: hello.id });
    expect(await text('/')).toContain('欢迎来到这里');
    const move = async (parentId: string | null) => {
      const { revision } = await ok<NoteDetail>(`/api/nodes/${hello.id}`);
      await ok(`/api/nodes/${hello.id}`, 'PATCH', { revision, parentId });
    };
    await move(null);
    expect(await text('/')).not.toContain('欢迎来到这里');
    expect((await visit('/blog')).status).toBe(301);
    // The page keeps its place, so saving the rest of the form still works.
    expect((await ok<BlogSettings>('/api/blog/settings')).pages).toEqual({ home: hello.id });
    expect((await settings({ pages: {} }, root)).status).toBe(200);
    await move(root);
    expect(await text('/')).toContain('欢迎来到这里');
  });

  it('drops the page when its post is unpublished', async () => {
    const root = await folder('博客');
    await setRoot(root);
    const about = await note('关于', root, '内容');
    await assign(root, { about: about.id });
    await ok(`/api/blog/posts/${about.id}`, 'DELETE');
    expect((await ok<BlogSettings>('/api/blog/settings')).pages).toEqual({});
    expect((await visit('/about')).status).toBe(404);
  });
});

describe('blog font preloading', () => {
  it('preloads only the fonts a page uses', async () => {
    const root = await folder('博客');
    await setRoot(root);
    await bindings.DB.prepare("UPDATE site SET blog_theme='paper' WHERE id=1").run();
    await publish(await note('公式', root, '$\\mathbb{R}$ 与 $x$'), 'math');
    await publish(await note('正文', root, '没有公式'), 'plain');
    const math = await text('/posts/math');
    expect(math).toContain('/assets/fonts/KaTeX_Main-Regular.woff2');
    expect(math).toContain('/assets/fonts/KaTeX_AMS-Regular.woff2');
    expect(math).not.toContain('KaTeX_Caligraphic');
    expect(math).not.toContain('special-elite');
    expect(await text('/posts/plain')).not.toContain('rel="preload"');
    await bindings.DB.prepare("UPDATE site SET blog_theme='typing' WHERE id=1").run();
    await refreshBlog(bindings);
    expect(await text('/posts/plain')).toContain('/assets/fonts/special-elite-latin-400-normal.woff2');
  });
});

describe('blog summaries', () => {
  const BODY = `# 文章\n\n${'这是一段足够长的正文，用来确认摘要的来源。'.repeat(10)}`;
  const reply = (content: string) =>
    new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  const provider = (...replies: string[]) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(replies.shift() ?? '多余的调用'));
  const sent = (fetch: { mock: { calls: unknown[][] } }, call = 0) =>
    (fetch.mock.calls[call][1] as RequestInit).body as string;
  const withKey = () => ok('/api/ai/settings', 'PUT', { apiKey: 'sk-test-only-fake-deepseek-key' });
  const blogRoot = async () => {
    const root = await folder('博客');
    await setRoot(root);
    return root;
  };
  afterEach(() => vi.restoreAllMocks());

  it('generates once per published version, not on saves', async () => {
    await withKey();
    const fetch = provider('第一版摘要', '第二版摘要');
    const post = await note('文章', await blogRoot(), BODY);
    const first = await publish(post, 'post');
    expect(first.post).toMatchObject({ summary: '第一版摘要', summarySource: 'ai' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sent(fetch)).toContain('这是一段足够长的正文');
    expect(await text('/')).toContain('第一版摘要');

    // Only the link changes: same version, no call.
    await publish(post, 'renamed');
    expect(fetch).toHaveBeenCalledTimes(1);

    const saved = await save(post.id, `${BODY}\n\n还没有发布的秘密段落`);
    expect(fetch).toHaveBeenCalledTimes(1);
    const updated = await publish(saved);
    expect(updated.post).toMatchObject({ summary: '第二版摘要', summarySource: 'ai', slug: 'renamed' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sent(fetch, 1)).toContain('还没有发布的秘密段落');
  });

  it('still publishes, with the excerpt, when the call cannot succeed', async () => {
    const root = await blogRoot();
    const fetch = vi.spyOn(globalThis, 'fetch');
    const unconfigured = await publish(await note('没有密钥', root, BODY));
    expect(unconfigured.post).toMatchObject({ summarySource: 'excerpt', online: true });
    expect(unconfigured.post!.summary).toContain('这是一段足够长的正文');
    expect(fetch).not.toHaveBeenCalled();

    await withKey();
    fetch.mockImplementation(async () => new Response('{}', { status: 402 }));
    const post = await note('余额不足', root, BODY);
    expect((await publish(post)).post).toMatchObject({ summarySource: 'excerpt', online: true });
    expect(fetch).toHaveBeenCalledTimes(1);

    fetch.mockImplementation(async () => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    expect((await publish(await note('连不上', root, BODY))).post).toMatchObject({ summarySource: 'excerpt' });
  });

  it('spends nothing on short posts, pages or a taken link', async () => {
    await withKey();
    const fetch = provider('摘要');
    const root = await blogRoot();
    expect((await publish(await note('短文', root, '只有一句话。'))).post).toMatchObject({
      summary: '只有一句话。',
      summarySource: 'excerpt',
    });
    const response = await call(`/api/blog/posts/${(await note('撞车', root, BODY)).id}`, 'PUT', {
      revision: 1,
      slug: '短文',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'BLOG_SLUG_TAKEN' });

    const page = await note('关于', root, BODY);
    await ok('/api/blog/settings', 'PUT', { parentId: root, title: '我的博客', pages: { about: page.id } });
    const saved = await save(page.id, `${BODY}\n\n新段落`);
    expect((await publish(saved)).post).toMatchObject({ page: 'about', summarySource: 'excerpt' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps a hand-written summary across updates until replaced', async () => {
    await withKey();
    const fetch = provider('青藜的摘要', '重新生成的摘要');
    const post = await note('文章', await blogRoot(), BODY);
    const before = await publish(post, 'post');
    const manual = await ok<BlogNoteStatus>(`/api/blog/posts/${post.id}/summary`, 'PUT', { summary: ' 我\n写的 ' });
    expect(manual.post).toMatchObject({ summary: '我 写的', summarySource: 'manual', updatedAt: before.post!.updatedAt });
    expect(await text('/')).toContain('我 写的');

    const saved = await save(post.id, `${BODY}\n\n新段落`);
    expect((await publish(saved)).post).toMatchObject({ summary: '我 写的', summarySource: 'manual' });
    expect(fetch).toHaveBeenCalledTimes(1);

    const again = await ok<BlogNoteStatus>(`/api/blog/posts/${post.id}/summary`, 'POST');
    expect(again.post).toMatchObject({ summary: '重新生成的摘要', summarySource: 'ai' });

    const cleared = await ok<BlogNoteStatus>(`/api/blog/posts/${post.id}/summary`, 'PUT', { summary: '  ' });
    expect(cleared.post!.summarySource).toBe('excerpt');
    expect(cleared.post!.summary).toContain('这是一段足够长的正文');
  });

  it('regenerates from the published version and reports failures', async () => {
    await withKey();
    const fetch = provider('旧摘要', '新摘要');
    const post = await note('文章', await blogRoot(), BODY);
    await publish(post, 'post');
    await save(post.id, `${BODY}\n\n还没有发布的秘密段落`);
    await ok(`/api/blog/posts/${post.id}/summary`, 'POST');
    expect(sent(fetch, 1)).not.toContain('还没有发布的秘密段落');

    fetch.mockImplementation(async () => new Response('{}', { status: 402 }));
    expect((await call(`/api/blog/posts/${post.id}/summary`, 'POST')).status).toBe(502);
    expect((await ok<BlogNoteStatus>(`/api/blog/posts/${post.id}`)).post!.summary).toBe('新摘要');

    expect((await call(`/api/blog/posts/${(await note('未发布', null, BODY)).id}/summary`, 'POST')).status).toBe(404);
  });

  it('caps a long reply and refuses an over-long manual summary', async () => {
    await withKey();
    provider('长'.repeat(300));
    const post = await note('文章', await blogRoot(), BODY);
    expect([...(await publish(post, 'post')).post!.summary]).toHaveLength(161);
    expect((await call(`/api/blog/posts/${post.id}/summary`, 'PUT', { summary: '长'.repeat(161) })).status).toBe(400);
  });

  it('is closed to command-line tokens', async () => {
    const post = await note('文章', await blogRoot(), BODY);
    await publish(post, 'post');
    const { token } = await ok<{ token: string }>('/api/tokens', 'POST', { name: '电脑', scope: 'write' });
    const byToken = await SELF.fetch(`${ORIGIN}/api/blog/posts/${post.id}/summary`, {
      method: 'POST',
      headers: { origin: ORIGIN, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    expect(byToken.status).toBe(403);
  });
});

describe('blog text helpers', () => {
  it('derives links and summaries', () => {
    expect(blogSlug('  Hello, 世界！ 2026 ')).toBe('hello-世界-2026');
    expect(blogSlug('！！！')).toBe('');
    expect(
      blogExcerpt('---\ntitle: x\n---\n# 标题\n\n**正文** [链接](https://a.test) ![图](/x.png)\n\n```js\ncode\n```\n结束', '标题'),
    ).toBe('正文 链接 结束');
    expect(blogExcerpt('公式 $E=mc^2$ 与 \\$5\n\n## 小标题\n\n| 甲 | 乙 |\n| --- | --- |\n\n- 列表')).toBe('公式 与 \\$5 列表');
    expect([...blogExcerpt('字'.repeat(200))]).toHaveLength(161);
  });
});
