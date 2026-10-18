/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, SELF, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../worker/types';
import type {
  FileInfo,
  NoteNode,
  NoteDetail,
  StorageInfo,
  VersionInfo,
  ShareSettings,
  SearchResult,
} from '../shared/types';
import { cleanup } from '../worker/recovery';
import { indexPending, indexStatement } from '../worker/note-text';
import { discardFile, storeText, uploadFile } from '../worker/storage';
import { editToken, requireSession } from '../worker/auth';

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
let cookie = '';
const notes = new Map<string, string>();
beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});
async function request(
  path: string,
  method = 'GET',
  data?: unknown,
  options: { anonymous?: boolean; locked?: boolean; origin?: string; key?: string } = {},
) {
  const id = path.match(/^\/api\/nodes\/([^/]+)/)?.[1];
  return SELF.fetch(`https://notes.test${path}`, {
    method,
    headers: {
      origin: options.origin || 'https://notes.test',
      'content-type': 'application/json',
      ...(!options.anonymous ? { cookie } : {}),
      ...(!options.locked && id && notes.has(id) ? { 'x-note-edit': notes.get(id)! } : {}),
      ...(options.key ? { 'x-idempotency-key': options.key } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}
async function ok<T = Record<string, unknown>>(
  path: string,
  method = 'GET',
  data?: unknown,
  options = {},
): Promise<T> {
  const response = await request(path, method, data, options);
  expect(response.ok, await response.clone().text()).toBe(true);
  return response.json() as Promise<T>;
}
beforeEach(async () => {
  await bindings.DB.batch([
    bindings.DB.prepare('DELETE FROM nodes'),
    bindings.DB.prepare('DELETE FROM trash_batches'),
    bindings.DB.prepare('DELETE FROM blobs'),
    bindings.DB.prepare('DELETE FROM idempotency'),
    bindings.DB.prepare('DELETE FROM sessions'),
    bindings.DB.prepare('DELETE FROM login_attempts'),
    bindings.DB.prepare(
      'UPDATE site SET password_hash=NULL,password_salt=NULL,auth_epoch=0,quota_bytes=8000000000,allocated_bytes=0 WHERE id=1',
    ),
  ]);
  const objects = await bindings.FILES.list();
  if (objects.objects.length)
    await bindings.FILES.delete(objects.objects.map((object) => object.key));
  notes.clear();
  cookie = '';
  const setup = await request('/api/auth/setup', 'POST', {
    token: bindings.SETUP_TOKEN,
    password: 'correct-horse-long-passphrase',
  });
  expect(setup.status, await setup.clone().text()).toBe(200);
  cookie = setup.headers.get('set-cookie')!.split(';')[0];
});
async function create(kind = 'markdown', title = '阅读笔记', extra: Record<string, unknown> = {}) {
  const node = await ok<NoteNode>('/api/nodes', 'POST', {
    kind,
    title,
    content: '# 开始\n正文',
    ...extra,
  });
  if (['markdown', 'text'].includes(kind))
    notes.set(
      node.id,
      (await ok<{ token: string }>('/api/edit/unlock', 'POST', { nodeId: node.id })).token,
    );
  return node;
}
async function save(node: NoteNode, content: string, attachments: string[] = []) {
  return ok<NoteNode>(`/api/nodes/${node.id}/content`, 'PUT', {
    revision: node.revision,
    content,
    attachments,
  });
}
async function trash(node: NoteNode) {
  const preview = await ok<{ count: number }>(`/api/nodes/${node.id}/delete-preview`);
  return ok<{ id: string }>(`/api/nodes/${node.id}`, 'DELETE', { count: preview.count });
}
const png = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1,
]);
async function file(name = 'picture.png'): Promise<FileInfo> {
  const response = await SELF.fetch(
    `https://notes.test/api/files?name=${name}&size=${png.length}`,
    {
      method: 'POST',
      headers: { origin: 'https://notes.test', cookie },
      body: png,
    },
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json() as Promise<FileInfo>;
}

describe('private library behavior', () => {
  it('sorts the complete directory before pagination and only previews the current indexed body', async () => {
    const folder = await create('folder', '排序');
    await bindings.DB.batch(Array.from({ length: 105 }, (_, index) => bindings.DB.prepare(
      'INSERT INTO nodes(id,parent_id,kind,title,position,created_at,updated_at) VALUES(?,?,\'folder\',?,?,?,?)',
    ).bind(crypto.randomUUID(), folder.id, `条目 ${String(104 - index).padStart(3, '0')}`, index, index, index)));
    const first = await ok<{ nodes: NoteNode[]; nextOffset: number }>(`/api/nodes?parent=${folder.id}&sort=title`);
    expect(first.nodes).toHaveLength(100);
    expect(first.nodes[0].title).toBe('条目 000');
    const last = await ok<{ nodes: NoteNode[] }>(`/api/nodes?parent=${folder.id}&sort=title&offset=${first.nextOffset}`);
    expect(last.nodes.map((node) => node.title)).toEqual(['条目 100', '条目 101', '条目 102', '条目 103', '条目 104']);
    const note = await create('markdown', '摘要', { content: '# 标题\n\n**摘要文字**' });
    const listed = (await ok<{ nodes: NoteNode[] }>('/api/nodes?parent=')).nodes.find((node) => node.id === note.id)!;
    expect(listed.preview).toContain('摘要文字');
    expect(listed.preview).not.toContain('**');
    await bindings.DB.prepare("UPDATE note_text SET version_id='stale-version' WHERE node_id=?").bind(note.id).run();
    expect((await ok<{ nodes: NoteNode[] }>('/api/nodes?parent=')).nodes.find((node) => node.id === note.id)!.preview).toBeNull();
  });
  it('filters search across descendants and types before limiting, and ranks exact titles ahead of newer partial matches', async () => {
    const folder = await create('folder', '范围');
    const nested = await create('folder', '内层', { parentId: folder.id });
    const exact = await create('markdown', '线索', { parentId: nested.id, content: '正文内容' });
    await bindings.DB.prepare('UPDATE nodes SET updated_at=1 WHERE id=?').bind(exact.id).run();
    const outside = await create('markdown', '线索 外部');
    for (let i = 0; i < 32; i++) await create('folder', `线索 ${i}`);
    const relevant = await ok<{ results: SearchResult[] }>('/api/search?q=线索');
    expect(relevant.results[0].id).toBe(exact.id);
    const filtered = await ok<{ results: SearchResult[] }>(`/api/search?q=线索&parent=${folder.id}&type=note`);
    expect(filtered.results.map((node) => node.id)).toEqual([exact.id]);
    expect(filtered.results[0].ancestor_ids).toEqual([folder.id, nested.id]);
    expect(filtered.results.some((node) => node.id === outside.id)).toBe(false);
    expect((await request('/api/search?q=线索&type=invalid')).status).toBe(400);
    const body = await create('markdown', '只有正文匹配', { content: '线索在这里' });
    await bindings.DB.prepare('UPDATE nodes SET updated_at=9999999999999 WHERE id=?').bind(body.id).run();
    expect((await ok<{ results: SearchResult[] }>('/api/search?q=线索&sort=updated')).results[0].id).toBe(body.id);
  });
  it('searches titles by every word, with ancestor paths, skipping trash and escaping wildcards', async () => {
    const folder = await create('folder', '读书');
    const book = await create('markdown', 'Deep Learning 笔记', { parentId: folder.id });
    const chapter = await create('markdown', '第 3 章 learning rate', { parentId: book.id });
    await create('markdown', '100% 完成');
    const gone = await create('markdown', 'Deep learning 草稿');
    await trash(gone);
    const search = (q: string) =>
      ok<{ results: (NoteNode & { path: string[] })[] }>(`/api/search?q=${encodeURIComponent(q)}`);
    const learning = await search('LEARNING');
    expect(learning.results.map((node) => node.id).sort()).toEqual([book.id, chapter.id].sort());
    expect(learning.results.find((node) => node.id === chapter.id)!.path).toEqual([
      '读书',
      'Deep Learning 笔记',
    ]);
    expect(learning.results.find((node) => node.id === book.id)!.path).toEqual(['读书']);
    expect((await search('deep 笔记')).results.map((node) => node.id)).toEqual([book.id]);
    expect((await search('%')).results.map((node) => node.title)).toEqual(['100% 完成']);
    expect((await search('_')).results).toEqual([]);
    expect((await search('  ')).results).toEqual([]);
    expect((await request('/api/search?q=x', 'GET', undefined, { anonymous: true })).status).toBe(
      401,
    );
  });

  it('searches note bodies with context, short words, saves, restores and trash', async () => {
    type Results = { results: SearchResult[] };
    const search = (q: string) => ok<Results>(`/api/search?q=${encodeURIComponent(q)}`);
    const note = await create('markdown', '周记', {
      content: '# 本周\n\n读完了 **注意力机制** 一章，[论文](https://example.com/attention) 还要再看。',
    });
    const plain = await create('text', '摘抄', { content: 'Attention is all you need.' });
    let found = (await search('注意力机制')).results;
    expect(found.map((node) => node.id)).toEqual([note.id]);
    // Markup and link targets are left out of what is searched and shown.
    expect(found[0].excerpt).toBe('本周 读完了 注意力机制 一章，论文 还要再看。');
    expect((await search('example.com')).results).toEqual([]);
    // Two-character words scan instead of using the trigram index.
    expect((await search('读完 论文')).results.map((node) => node.id)).toEqual([note.id]);
    expect((await search('ATTENTION')).results.map((node) => node.id)).toEqual([plain.id]);
    // A title match gains the body's context instead of a second result.
    found = (await search('周记')).results;
    expect(found).toHaveLength(1);
    expect(found[0].excerpt).toBeUndefined();
    const saved = await save(note, '换了内容：周记里写自注意力。');
    found = (await search('周记')).results;
    expect(found).toHaveLength(1);
    expect(found[0].excerpt).toBe('换了内容：周记里写自注意力。');
    expect((await search('注意力机制')).results).toEqual([]);
    const { versions } = await ok<{ versions: VersionInfo[] }>(`/api/nodes/${note.id}/versions`);
    await ok(`/api/nodes/${note.id}/versions/${versions.at(-1)!.id}/restore`, 'POST', {
      revision: saved.revision,
    });
    expect((await search('注意力机制')).results.map((node) => node.id)).toEqual([note.id]);
    await trash(plain);
    expect((await search('attention')).results).toEqual([]);
  });

  it('indexes bodies saved before the index in small batches', async () => {
    for (let i = 0; i < 12; i++) await create('markdown', `旧笔记 ${i}`, { content: `历史正文 ${i}` });
    await bindings.DB.prepare('DELETE FROM note_text').run();
    const search = () => ok<{ results: SearchResult[] }>('/api/search?q=历史正文');
    expect((await search()).results).toEqual([]);
    expect(await ok('/api/search/index', 'POST', {})).toEqual({ indexed: 10, more: true });
    expect(await ok('/api/search/index', 'POST', {})).toEqual({ indexed: 2, more: false });
    expect(await ok('/api/search/index', 'POST', {})).toEqual({ indexed: 0, more: false });
    expect((await search()).results).toHaveLength(12);
    // The scheduled cleanup fills the index too.
    await bindings.DB.prepare('DELETE FROM note_text').run();
    await cleanup(bindings, { files: false });
    expect((await search()).results).toHaveLength(5);
    // Deleting a note for good removes its text.
    const [first] = (await search()).results;
    await bindings.DB.prepare('DELETE FROM nodes WHERE id=?').bind(first.id).run();
    expect(
      await bindings.DB.prepare('SELECT COUNT(*) count FROM note_text WHERE node_id=?').bind(first.id).first('count'),
    ).toBe(0);
  });

  it('does not index a body that became encrypted after it was read', async () => {
    const note = await create('markdown', '读过的笔记', { content: '读出时的明文' });
    await bindings.DB.prepare('DELETE FROM note_text').run();
    const row = await bindings.DB.prepare(
      'SELECT b.id,b.object_key FROM nodes n JOIN versions v ON v.id=n.current_version_id JOIN blobs b ON b.id=v.body_blob_id WHERE n.id=?',
    )
      .bind(note.id)
      .first<{ id: string; object_key: string }>();
    // Read, then re-sealed in place under the same version before the write.
    const late = indexStatement(bindings, note.id, note.current_version_id!, 'markdown', '读出时的明文', row!.object_key);
    await bindings.DB.prepare("UPDATE blobs SET object_key=?,key_id='k' WHERE id=?")
      .bind(`${row!.object_key}/sealed`, row!.id)
      .run();
    await late.run();
    expect(await bindings.DB.prepare('SELECT COUNT(*) n FROM note_text').first('n')).toBe(0);
    // A replaced object is not the one that was read either, even if plain.
    await bindings.DB.prepare('UPDATE blobs SET key_id=NULL WHERE id=?').bind(row!.id).run();
    await late.run();
    expect(await bindings.DB.prepare('SELECT COUNT(*) n FROM note_text').first('n')).toBe(0);
  });

  it('retries a body that could not be read instead of indexing it empty', async () => {
    const note = await create('markdown', '暂时读不到', { content: '稍后才能读到的正文' });
    await bindings.DB.prepare('DELETE FROM note_text').run();
    const { object_key } = (await bindings.DB.prepare(
      'SELECT b.object_key FROM nodes n JOIN versions v ON v.id=n.current_version_id JOIN blobs b ON b.id=v.body_blob_id WHERE n.id=?',
    )
      .bind(note.id)
      .first<{ object_key: string }>())!;
    const object = await bindings.FILES.get(object_key);
    const bytes = await object!.arrayBuffer();
    await bindings.FILES.delete(object_key);
    expect(await indexPending(bindings, 10)).toEqual({ indexed: 0, more: false });
    const failed = await bindings.DB.prepare('SELECT body,retry_at,attempts FROM note_text WHERE node_id=?')
      .bind(note.id)
      .first<{ body: string; retry_at: number; attempts: number }>();
    expect(failed).toMatchObject({ body: '', attempts: 1 });
    expect(failed!.retry_at).toBeGreaterThan(Date.now());
    // Not due yet: other notes go on, this one waits.
    expect(await indexPending(bindings, 10)).toEqual({ indexed: 0, more: false });
    await bindings.FILES.put(object_key, bytes);
    await bindings.DB.prepare('UPDATE note_text SET retry_at=0').run();
    expect(await indexPending(bindings, 10)).toEqual({ indexed: 1, more: false });
    expect(
      (await ok<{ results: SearchResult[] }>('/api/search?q=稍后才能读到')).results.map((item) => item.id),
    ).toEqual([note.id]);
  });

  it('creates untitled notes and folders while keeping uploaded filenames and rename validation', async () => {
    for (const [kind, title] of [
      ['markdown', '未命名笔记'],
      ['text', '未命名文本'],
      ['folder', '未命名文件夹'],
      ['link', '未命名链接'],
    ]) {
      const node = await ok<NoteNode>('/api/nodes', 'POST', {
        kind,
        title: '  ',
        url: 'https://example.com',
      });
      expect(node.title).toBe(title);
      expect(
        (await request(`/api/nodes/${node.id}`, 'PATCH', { revision: node.revision, title: '  ' }))
          .status,
      ).toBe(400);
    }
    expect((await ok<NoteNode>('/api/nodes', 'POST', { kind: 'markdown' })).title).toBe(
      '未命名笔记',
    );
    const image = await file('original.png');
    expect(
      (await ok<NoteNode>('/api/nodes', 'POST', { kind: 'image', title: '', fileId: image.id }))
        .title,
    ).toBe('original.png');
  });
  it('keeps share destinations across sessions and follows moves, rename, trash and purge', async () => {
    expect(await ok('/api/share/settings')).toEqual({ parentId: null, breadcrumbs: [] });
    const folder = await create('folder', '收集');
    const nested = await create('folder', '稍后阅读', { parentId: folder.id });
    const saved = await ok<ShareSettings>('/api/share/settings', 'PUT', { parentId: nested.id });
    expect(saved).toEqual({
      parentId: nested.id,
      breadcrumbs: [
        { id: folder.id, title: folder.title },
        { id: nested.id, title: nested.title },
      ],
    });
    // A fresh request returns account state, independent of a browser's local storage.
    expect(await ok('/api/share/settings')).toEqual(saved);
    await ok(`/api/nodes/${nested.id}`, 'PATCH', {
      revision: nested.revision,
      title: '分享收件箱',
      parentId: null,
    });
    expect(await ok('/api/share/settings')).toEqual({
      parentId: nested.id,
      breadcrumbs: [{ id: nested.id, title: '分享收件箱' }],
    });
    const fresh = await ok<NoteNode>(`/api/nodes/${nested.id}`);
    await ok(`/api/nodes/${nested.id}`, 'PATCH', { revision: fresh.revision, parentId: folder.id });
    const batch = await trash(folder);
    expect(await ok('/api/share/settings')).toEqual({ parentId: null, breadcrumbs: [] });
    expect((await request('/api/share/settings', 'PUT', { parentId: nested.id })).status).toBe(409);
    await ok(`/api/trash/${batch.id}/restore`, 'POST', {});
    expect((await ok<ShareSettings>('/api/share/settings')).parentId).toBeNull();
    await ok('/api/share/settings', 'PUT', { parentId: nested.id });
    // FK fallback also covers direct permanent deletion.
    await bindings.DB.prepare('DELETE FROM nodes WHERE id=?').bind(nested.id).run();
    expect((await ok<ShareSettings>('/api/share/settings')).parentId).toBeNull();
    expect((await request('/api/share/settings', 'PUT', { parentId: 'missing' })).status).toBe(409);
    expect((await request('/api/share/settings', 'PUT', {})).status).toBe(400);
    for (const method of ['GET', 'PUT'])
      expect(
        (
          await request(
            '/api/share/settings',
            method,
            method === 'PUT' ? { parentId: null } : undefined,
            { anonymous: true },
          )
        ).status,
      ).toBe(401);
    expect(
      (
        await request(
          '/api/share/settings',
          'PUT',
          { parentId: folder.id },
          { origin: 'https://elsewhere.test' },
        )
      ).status,
    ).toBe(403);
    await ok('/api/share/settings', 'PUT', { parentId: null });
  });
  it('supports compound emoji and image folder icons without unlocking and preserves referenced bytes', async () => {
    const folder = await create('folder', '研究', { icon: { emoji: '👩🏽‍🔬' } });
    expect(folder.icon_emoji).toBe('👩🏽‍🔬');
    const renamed = await ok<NoteNode>(`/api/nodes/${folder.id}`, 'PATCH', {
      title: '研究资料',
      revision: folder.revision,
    });
    expect(renamed.icon_emoji).toBe('👩🏽‍🔬');
    const image = await file();
    const pictured = await ok<NoteNode>(
      `/api/nodes/${folder.id}`,
      'PATCH',
      { revision: renamed.revision, icon: { fileId: image.id } },
      { locked: true },
    );
    expect(pictured).toMatchObject({ icon_emoji: null, icon_blob_id: image.id });
    expect((await ok<{ nodes: NoteNode[] }>('/api/nodes')).nodes[0].icon_blob_id).toBe(image.id);
    expect(await discardFile(bindings, image.id)).toBe(false);
    await bindings.DB.prepare('UPDATE blobs SET draft_until=0 WHERE id=?').bind(image.id).run();
    await cleanup(bindings);
    expect((await request(`/api/files/${image.id}`)).status).toBe(200);
    expect(await ok<StorageInfo>('/api/storage')).toMatchObject({
      currentBytes: image.size,
      orphanBytes: 0,
    });
    // The quota check reads the same totals without the per-file breakdown.
    const full = await ok<StorageInfo>('/api/storage');
    expect(await ok('/api/storage/usage')).toEqual({
      quotaBytes: full.quotaBytes,
      allocatedBytes: full.allocatedBytes,
    });
    const batch = await trash(pictured);
    expect(await ok<StorageInfo>('/api/storage')).toMatchObject({
      currentBytes: 0,
      trashBytes: image.size,
    });
    await cleanup(bindings);
    expect((await request(`/api/files/${image.id}`)).status).toBe(200);
    await ok(`/api/trash/${batch.id}/restore`, 'POST', {});
    const restored = await ok<NoteNode>(`/api/nodes/${folder.id}`);
    expect(restored.icon_blob_id).toBe(image.id);
    expect(
      (
        await request(`/api/nodes/${folder.id}`, 'PATCH', {
          revision: pictured.revision,
          icon: null,
        })
      ).status,
    ).toBe(409);
    const reset = await ok<NoteNode>(`/api/nodes/${folder.id}`, 'PATCH', {
      revision: restored.revision,
      icon: null,
    });
    expect(reset).toMatchObject({ icon_emoji: null, icon_blob_id: null });
    expect((await request(`/api/files/${image.id}`)).status).toBe(404);
    expect((await ok<StorageInfo>('/api/storage')).allocatedBytes).toBe(0);
  });
  it('rejects invalid icons and guards the ready-file transition inside the database', async () => {
    const image = await file();
    const text = await storeText(bindings, 'not an image');
    for (const icon of [
      { emoji: 'hello' },
      { emoji: '📚📚' },
      { emoji: '📚', fileId: image.id },
      { fileId: text.id },
      { fileId: 'missing' },
    ])
      expect(
        (await request('/api/nodes', 'POST', { kind: 'folder', title: 'invalid', icon })).ok,
      ).toBe(false);
    expect(
      (
        await request('/api/nodes', 'POST', {
          kind: 'markdown',
          title: 'invalid',
          icon: { emoji: '📚' },
        })
      ).status,
    ).toBe(400);
    const folder = await create('folder', '图标测试', { icon: { emoji: '🇨🇳' } });
    const keycap = await ok<NoteNode>(`/api/nodes/${folder.id}`, 'PATCH', {
      revision: folder.revision,
      icon: { emoji: '1️⃣' },
    });
    expect(keycap.icon_emoji).toBe('1️⃣');
    await bindings.DB.prepare("UPDATE blobs SET state='deleting' WHERE id=?").bind(image.id).run();
    await expect(
      bindings.DB.prepare('UPDATE nodes SET icon_emoji=NULL,icon_blob_id=? WHERE id=?')
        .bind(image.id, folder.id)
        .run(),
    ).rejects.toThrow('FILE_UNAVAILABLE');
    expect((await ok<NoteNode>(`/api/nodes/${folder.id}`)).icon_emoji).toBe('1️⃣');
    const oversized = new Uint8Array(128 * 1024 + 1);
    oversized.set(png);
    const uploaded = await uploadFile(
      bindings,
      new Request(`https://notes.test/api/files?name=large.png&size=${oversized.length}`, {
        method: 'POST',
        body: oversized,
      }),
    );
    expect(
      (
        await request(`/api/nodes/${folder.id}`, 'PATCH', {
          revision: keycap.revision,
          icon: { fileId: uploaded.id },
        })
      ).status,
    ).toBe(400);
  });
  it('protects private surfaces and requires confirmation only for file content changes', async () => {
    const node = await create(),
      asset = await file();
    for (const path of [
      '/api/nodes',
      `/api/nodes/${node.id}`,
      `/api/nodes/${node.id}/versions`,
      `/api/files/${asset.id}`,
      '/api/trash',
      '/api/storage',
    ]) {
      expect((await request(path, 'GET', undefined, { anonymous: true })).status).toBe(401);
    }
    expect(
      (await request('/api/nodes', 'POST', { kind: 'folder', title: '直接新建' }, { locked: true }))
        .status,
    ).toBe(201);
    expect((await request('/api/edit/unlock', 'POST', {})).status).toBe(400);
    notes.delete(node.id);
    expect(
      (
        await request(`/api/nodes/${node.id}/content`, 'PUT', {
          revision: 1,
          content: 'blocked',
          attachments: [],
        })
      ).status,
    ).toBe(403);
    const { versions } = await ok<{ versions: VersionInfo[] }>(`/api/nodes/${node.id}/versions`);
    expect(
      (
        await request(`/api/nodes/${node.id}/versions/${versions[0].id}/restore`, 'POST', {
          revision: node.revision,
        })
      ).status,
    ).toBe(403);
    expect(
      (await request(`/api/nodes/${node.id}/favorite`, 'PUT', { enabled: true }, { locked: true }))
        .status,
    ).toBe(200);
    expect(
      (
        await request(
          '/api/nodes',
          'POST',
          { kind: 'folder', title: 'blocked' },
          { origin: 'https://evil.test' },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request('/api/nodes', 'POST', {
          kind: 'link',
          title: 'bad link',
          url: 'javascript:alert(1)',
        })
      ).status,
    ).toBe(400);
  });
  it('allows settings and library management without unlocking file content', async () => {
    const node = await create();
    notes.clear();
    const asset = await file();
    await ok(`/api/files/${asset.id}`, 'DELETE');
    expect(
      await ok<StorageInfo>('/api/settings', 'PATCH', { quotaBytes: 1_000_000 }),
    ).toMatchObject({ quotaBytes: 1_000_000 });
    const renamed = await ok<NoteNode>(`/api/nodes/${node.id}`, 'PATCH', {
      title: '直接改名',
      revision: node.revision,
    });
    const batch = await trash(renamed);
    await ok(`/api/trash/${batch.id}/restore`, 'POST', {});
    expect((await ok<NoteDetail>(`/api/nodes/${node.id}`)).title).toBe('直接改名');
    const deleted = await trash(renamed);
    await ok(`/api/trash/${deleted.id}`, 'DELETE');
    await ok('/api/cleanup', 'POST', {});
    for (const options of [{ anonymous: true }, { origin: 'https://elsewhere.test' }]) {
      expect(
        (await request('/api/settings', 'PATCH', { quotaBytes: 2_000_000 }, options)).status,
      ).toBe(options.anonymous ? 401 : 403);
    }
  });
  it('binds file editing to the selected file, session and token lifetime', async () => {
    const first = await create(),
      second = await create();
    const token = notes.get(first.id)!;
    notes.set(first.id, notes.get(second.id)!);
    const payload = { revision: first.revision, content: '修改正文', attachments: [] };
    const locked = async () => {
      const response = await request(`/api/nodes/${first.id}/content`, 'PUT', payload);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'EDIT_LOCKED' });
    };
    await locked();
    const session = await requireSession(
      new Request('https://notes.test', { headers: { cookie } }),
      bindings,
    );
    notes.set(
      first.id,
      await editToken(bindings, { ...session, expires_at: Date.now() - 1 }, first.id),
    );
    await locked();
    notes.set(first.id, token);
    const login = await request('/api/auth/login', 'POST', {
      password: 'correct-horse-long-passphrase',
    });
    cookie = login.headers.get('set-cookie')!.split(';')[0];
    await locked();
    notes.set(
      first.id,
      (await ok<{ token: string }>('/api/edit/unlock', 'POST', { nodeId: first.id })).token,
    );
    await ok(`/api/nodes/${first.id}/content`, 'PUT', payload);
    expect((await ok<NoteDetail>(`/api/nodes/${first.id}`)).content).toBe('修改正文');
    expect((await ok<NoteDetail>(`/api/nodes/${second.id}`)).content).toBe('# 开始\n正文');
  });
  it('supports notes with children, rejects cycles and preserves stable links when moving', async () => {
    const parent = await create(),
      child = await create('text', '子笔记', { parentId: parent.id }),
      destination = await create('folder', '新位置');
    expect(
      (
        await request(`/api/nodes/${parent.id}`, 'PATCH', {
          revision: parent.revision,
          parentId: child.id,
        })
      ).status,
    ).toBe(400);
    const moved = await ok<NoteNode>(`/api/nodes/${child.id}`, 'PATCH', {
      revision: child.revision,
      title: '改名以后',
      parentId: destination.id,
    });
    expect(moved.id).toBe(child.id);
    expect(moved.parent_id).toBe(destination.id);
    const link = await create('link', '网站', { url: 'https://example.com' });
    expect(
      (
        await request('/api/nodes', 'POST', {
          kind: 'text',
          title: '链接的子笔记',
          parentId: link.id,
        })
      ).status,
    ).toBe(201);
    expect(
      (await ok<{ nodes: NoteNode[] }>(`/api/nodes?parent=${destination.id}`)).nodes.map(
        (n) => n.id,
      ),
    ).toEqual([child.id]);
  });
  it('keeps six versions, avoids no-op versions and restores immutable snapshots', async () => {
    let node = await create();
    node = await save(node, '# 开始\n正文');
    expect(
      (await ok<{ versions: VersionInfo[] }>(`/api/nodes/${node.id}/versions`)).versions,
    ).toHaveLength(1);
    for (let i = 2; i <= 9; i++) node = await save(node, `第 ${i} 次内容`);
    const versions = (await ok<{ versions: VersionInfo[] }>(`/api/nodes/${node.id}/versions`))
      .versions;
    expect(versions).toHaveLength(6);
    expect(versions.map((v) => v.sequence)).toEqual([9, 8, 7, 6, 5, 4]);
    const before = await ok<StorageInfo>('/api/storage');
    const restored = await ok<NoteNode>(
      `/api/nodes/${node.id}/versions/${versions[3].id}/restore`,
      'POST',
      { revision: node.revision },
    );
    expect(restored.revision).toBe(10);
    expect((await ok<NoteDetail>(`/api/nodes/${node.id}`)).content).toBe('第 6 次内容');
    expect((await ok<StorageInfo>('/api/storage')).allocatedBytes).toBe(before.allocatedBytes);
    await cleanup(bindings);
    expect((await ok<StorageInfo>('/api/storage')).orphanBytes).toBe(0);
  });
  it('accepts only one concurrent save and supports retry without duplicate versions', async () => {
    const node = await create();
    const results = await Promise.all(
      ['from laptop', 'from mobile'].map((content) =>
        request(`/api/nodes/${node.id}/content`, 'PUT', {
          revision: node.revision,
          content,
          attachments: [],
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    let latest = await ok<NoteDetail>(`/api/nodes/${node.id}`);
    const key = crypto.randomUUID(),
      data = { revision: latest.revision, content: 'idempotent save', attachments: [] };
    const first = await ok<NoteNode>(`/api/nodes/${node.id}/content`, 'PUT', data, { key });
    const second = await ok<NoteNode>(`/api/nodes/${node.id}/content`, 'PUT', data, { key });
    expect(second.revision).toBe(first.revision);
    expect(
      (await ok<{ versions: VersionInfo[] }>(`/api/nodes/${node.id}/versions`)).versions,
    ).toHaveLength(3);
    latest = await ok<NoteDetail>(`/api/nodes/${node.id}`);
    expect(latest.content).toBe('idempotent save');
  });
  it('rolls back failed attachment commits without damaging the saved note or accounting', async () => {
    const node = await create(),
      before = await ok<StorageInfo>('/api/storage');
    const failed = await request(`/api/nodes/${node.id}/content`, 'PUT', {
      revision: node.revision,
      content: 'should not persist',
      attachments: ['missing-file'],
    });
    expect(failed.status).toBe(409);
    expect((await ok<NoteDetail>(`/api/nodes/${node.id}`)).content).toBe('# 开始\n正文');
    expect((await ok<StorageInfo>('/api/storage')).allocatedBytes).toBe(before.allocatedBytes);
    expect(
      (await ok<{ versions: VersionInfo[] }>(`/api/nodes/${node.id}/versions`)).versions,
    ).toHaveLength(1);
  });
  it('reserves quota atomically under simultaneous uploads and permits reads when full', async () => {
    await bindings.DB.prepare('UPDATE site SET quota_bytes=30 WHERE id=1').run();
    const results = await Promise.all(
      [1, 2].map((i) =>
        SELF.fetch(`https://notes.test/api/files?name=${i}.png&size=${png.length}`, {
          method: 'POST',
          headers: { origin: 'https://notes.test', cookie },
          body: png,
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 413]);
    const successful = (await results.find((r) => r.status === 201)!.json()) as FileInfo;
    expect((await ok<StorageInfo>('/api/storage')).allocatedBytes).toBe(20);
    expect((await request(`/api/files/${successful.id}`)).status).toBe(200);
    await ok(`/api/files/${successful.id}`, 'DELETE');
    expect((await ok<StorageInfo>('/api/storage')).allocatedBytes).toBe(0);
  });
  it('shares attachment objects across nodes, versions and trash until the final reference disappears', async () => {
    const asset = await file(),
      note = await create('markdown', '带附件笔记', { attachments: [asset.id] });
    const image = await create('image', '同一张图片', { fileId: asset.id });
    const total = (await ok<StorageInfo>('/api/storage')).allocatedBytes;
    expect(total).toBe(png.length + new TextEncoder().encode('# 开始\n正文').length);
    expect((await request(`/api/files/${asset.id}`, 'DELETE')).status).toBe(409);
    const noteTrash = await trash(note);
    await ok(`/api/trash/${noteTrash.id}`, 'DELETE', {});
    await cleanup(bindings);
    expect((await request(`/api/files/${asset.id}`)).status).toBe(200);
    const imageTrash = await trash(image);
    await ok(`/api/trash/${imageTrash.id}`, 'DELETE', {});
    await cleanup(bindings);
    expect((await request(`/api/files/${asset.id}`)).status).toBe(404);
    expect((await ok<StorageInfo>('/api/storage')).allocatedBytes).toBe(0);
  });
  it('preserves an independently trashed child when its former parent is permanently deleted', async () => {
    const parent = await create('folder', '父目录'),
      child = await create('text', '先删除的子笔记', { parentId: parent.id }),
      sibling = await create('text', '仍有效的子笔记', { parentId: parent.id });
    const childTrash = await trash(child),
      parentTrash = await trash(parent);
    expect(
      (await ok<{ batches: { id: string; node_count: number }[] }>('/api/trash')).batches.find(
        (t) => t.id === parentTrash.id,
      )?.node_count,
    ).toBe(2);
    await ok(`/api/trash/${parentTrash.id}`, 'DELETE', {});
    await cleanup(bindings);
    const restored = await ok<{ rootId: string; movedToRoot: boolean }>(
      `/api/trash/${childTrash.id}/restore`,
      'POST',
      {},
    );
    expect(restored).toEqual({ rootId: child.id, movedToRoot: true });
    expect((await ok<NoteDetail>(`/api/nodes/${child.id}`)).parent_id).toBeNull();
    expect((await request(`/api/nodes/${sibling.id}`)).status).toBe(404);
  });
  it('checks delete counts, restores whole subtrees and hides trash from favorites/recent', async () => {
    const parent = await create('folder', '目录'),
      child = await create('markdown', '子笔记', { parentId: parent.id });
    await ok(`/api/nodes/${child.id}/favorite`, 'PUT', { enabled: true }, { locked: true });
    await ok(`/api/nodes/${child.id}/open`, 'POST', {}, { locked: true });
    expect((await request(`/api/nodes/${parent.id}`, 'DELETE', { count: 1 })).status).toBe(409);
    const batch = await trash(parent);
    expect((await ok<{ nodes: NoteNode[] }>('/api/nodes?view=favorites')).nodes).toHaveLength(0);
    expect((await ok<{ nodes: NoteNode[] }>('/api/nodes?view=recent')).nodes).toHaveLength(0);
    expect((await request(`/api/nodes/${child.id}`)).status).toBe(410);
    await ok(`/api/trash/${batch.id}/restore`, 'POST', {});
    expect((await ok<NoteDetail>(`/api/nodes/${child.id}`)).parent_id).toBe(parent.id);
    expect((await ok<{ nodes: NoteNode[] }>('/api/nodes?view=favorites')).nodes[0].id).toBe(
      child.id,
    );
    const again = await trash(await ok<NoteNode>(`/api/nodes/${parent.id}`));
    await bindings.DB.prepare('UPDATE trash_batches SET expires_at=0 WHERE id=?')
      .bind(again.id)
      .run();
    expect((await request(`/api/trash/${again.id}/restore`, 'POST', {})).status).toBe(410);
    await cleanup(bindings);
    expect((await request(`/api/nodes/${parent.id}`)).status).toBe(404);
  });
  it('uses compare-and-swap reading progress and limits recent entries to 20 distinct nodes', async () => {
    const node = await create();
    await ok(`/api/nodes/${node.id}/open`, 'POST', {}, { locked: true });
    await ok(
      `/api/nodes/${node.id}/reading`,
      'PUT',
      { version: 0, position: { ratio: 0.6, heading: 'heading-0' } },
      { locked: true },
    );
    expect(
      (
        await request(
          `/api/nodes/${node.id}/reading`,
          'PUT',
          { version: 0, position: { ratio: 0.1 } },
          { locked: true },
        )
      ).status,
    ).toBe(409);
    expect(await ok(`/api/nodes/${node.id}/reading`)).toMatchObject({
      version: 1,
      position: { ratio: 0.6 },
    });
    for (let i = 0; i < 22; i++) {
      const item = await create('folder', `目录${i}`);
      await ok(`/api/nodes/${item.id}/open`, 'POST', {});
    }
    await ok(`/api/nodes/${node.id}/open`, 'POST', {});
    const recent = (await ok<{ nodes: NoteNode[] }>('/api/nodes?view=recent')).nodes;
    expect(recent).toHaveLength(20);
    expect(recent[0].id).toBe(node.id);
    expect(recent[0].reading_position).toEqual({ ratio: 0.6, heading: 'heading-0' });
    expect(recent[1].reading_position).toEqual({});
    expect(new Set(recent.map((n) => n.id)).size).toBe(20);
  });
  it('continues reading past folders, images, journal entries and project items', async () => {
    const open = (node: NoteNode) => ok(`/api/nodes/${node.id}/open`, 'POST', {}, { locked: true });
    const continued = async () =>
      (await ok<{ nodes: NoteNode[] }>('/api/nodes?view=continue')).nodes;
    expect(await continued()).toEqual([]);
    const note = await create('markdown', '读物');
    await open(note);
    const book = await create('folder', '人类简史', { book: {} });
    const page = await create('markdown', '第 12 页', { parentId: book.id });
    await bindings.DB.prepare('INSERT INTO book_pages(node_id,page,updated_at) VALUES(?,12,0)')
      .bind(page.id)
      .run();
    await open(page);
    expect(await continued()).toMatchObject([
      { id: page.id, book_title: '人类简史', book_page_number: 12 },
    ]);
    const journal = await create('folder', '日记', { journal: true });
    const month = await create('folder', '10 月', { parentId: journal.id });
    const project = await create('folder', '开发', { project: true });
    const todo = await create('folder', 'todo', { parentId: project.id });
    for (const node of [
      await create('markdown', '今天', { parentId: month.id }),
      await create('markdown', '修复', { parentId: todo.id }),
      await create('image', '照片', { fileId: (await file()).id }),
      await create('folder', '目录'),
    ])
      await open(node);
    expect(await continued()).toMatchObject([{ id: page.id }]);
    await open(note);
    expect(await continued()).toMatchObject([{ id: note.id, book_title: null, book_page_number: null }]);
  });
  it('serves authenticated byte ranges and forces unknown active content to download', async () => {
    const asset = await file();
    const range = await SELF.fetch(`https://notes.test/api/files/${asset.id}`, {
      headers: { cookie, range: 'bytes=3-8' },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe('bytes 3-8/20');
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(png.slice(3, 9));
    const anonymous = await SELF.fetch(`https://notes.test/api/files/${asset.id}`, {
      headers: { range: 'bytes=3-8' },
    });
    expect(anonymous.status).toBe(401);
    const data = '<html><body onload="alert(1)">Untrusted HTML</body></html>';
    const response = await SELF.fetch(
      `https://notes.test/api/files?name=unsafe.html&size=${data.length}`,
      {
        method: 'POST',
        headers: { cookie, origin: 'https://notes.test' },
        body: data,
      },
    );
    const unsafe = (await response.json()) as FileInfo;
    const download = await request(`/api/files/${unsafe.id}`);
    expect(download.headers.get('content-type')).toBe('application/octet-stream');
    expect(download.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(download.headers.get('cache-control')).toContain('no-store');
    expect(download.headers.get('content-security-policy')).toContain('sandbox');
  });
  it('recovers storage failures and only releases accounted bytes after deletion succeeds', async () => {
    const broken = {
      ...bindings,
      FILES: {
        ...bindings.FILES,
        put: async () => {
          throw new Error('injected write failure');
        },
        delete: bindings.FILES.delete.bind(bindings.FILES),
      } as unknown as R2Bucket,
    };
    await expect(storeText(broken, 'never committed')).rejects.toThrow('injected write failure');
    expect((await ok<StorageInfo>('/api/storage')).allocatedBytes).toBe(0);
    const blob = await storeText(bindings, 'pending garbage');
    await bindings.DB.prepare('UPDATE blobs SET draft_until=0 WHERE id=?').bind(blob.id).run();
    const cannotDelete = {
      ...bindings,
      FILES: {
        delete: async () => {
          throw new Error('injected delete failure');
        },
      } as unknown as R2Bucket,
    };
    await cleanup(cannotDelete);
    expect((await ok<StorageInfo>('/api/storage')).allocatedBytes).toBe(blob.size);
    expect(
      await bindings.DB.prepare('SELECT state FROM blobs WHERE id=?').bind(blob.id).first(),
    ).toEqual({ state: 'deleting' });
    expect(
      (
        await request('/api/nodes', 'POST', {
          kind: 'markdown',
          title: 'racing reference',
          attachments: [blob.id],
        })
      ).status,
    ).toBe(409);
    await cleanup(bindings);
    expect((await ok<StorageInfo>('/api/storage')).allocatedBytes).toBe(0);
  });
  it('handles signatures split across stream chunks and rejects truncated uploads', async () => {
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === png.length) controller.close();
        else controller.enqueue(png.slice(offset, ++offset));
      },
    });
    const request = new Request(`https://notes.test/api/files?name=split.png&size=${png.length}`, {
      method: 'POST',
      body: stream,
    });
    const result = await uploadFile(bindings, request);
    expect(result.mime).toBe('image/png');
    await discardFile(bindings, result.id);
    await expect(
      uploadFile(
        bindings,
        new Request('https://notes.test/api/files?name=short.png&size=100', {
          method: 'POST',
          body: png,
        }),
      ),
    ).rejects.toThrow('上传未完成');
    expect((await ok<StorageInfo>('/api/storage')).allocatedBytes).toBe(0);
  });
});
