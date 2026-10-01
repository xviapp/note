/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, SELF, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../worker/types';
import type { FileInfo, NoteNode, NoteDetail, StorageInfo, VersionInfo } from '../shared/types';
import { cleanup } from '../worker/recovery';
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
    expect(new Set(recent.map((n) => n.id)).size).toBe(20);
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
