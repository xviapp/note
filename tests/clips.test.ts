/// <reference types="@cloudflare/vitest-pool-workers/types" />
import {
  env,
  SELF,
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../worker/index';
import type { Env } from '../worker/types';
import type { NoteNode } from '../shared/types';
import { CLIP_KEEP, CLIP_PAGE, CLIP_PINNED, type Clip, type ClipList } from '../shared/clips';
import type { LibraryBackup } from '../shared/backup';
import { cleanup } from '../worker/recovery';
import {
  exportContentKey,
  sealBytes,
  keyCheck,
  newContentKey,
  newSalt,
  openText,
  passwordKey,
  sealText,
  wrapContentKey,
} from '../shared/encryption';

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
let cookie = '';
let contexts: ExecutionContext[] = [];
beforeAll(() => applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS));
async function request(path: string, method = 'GET', data?: unknown) {
  const context = createExecutionContext();
  contexts.push(context);
  return worker.fetch(
    new Request(`https://notes.test${path}`, {
      method,
      headers: {
        origin: 'https://notes.test',
        'content-type': 'application/json',
        cookie,
        'x-idempotency-key': crypto.randomUUID(),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    }),
    bindings,
    context,
  );
}
async function ok<T = Record<string, unknown>>(path: string, method = 'GET', data?: unknown) {
  const response = await request(path, method, data);
  expect(response.ok, await response.clone().text()).toBe(true);
  return response.json() as Promise<T>;
}
beforeEach(async () => {
  contexts = [];
  cookie = '';
  await bindings.DB.batch([
    bindings.DB.prepare('DELETE FROM clips'),
    bindings.DB.prepare('DELETE FROM backup_jobs'),
    bindings.DB.prepare('DELETE FROM nodes'),
    bindings.DB.prepare('DELETE FROM trash_batches'),
    bindings.DB.prepare('DELETE FROM blobs'),
    bindings.DB.prepare('UPDATE site SET clip_key_id=NULL WHERE id=1'),
    bindings.DB.prepare('DELETE FROM encryption_keys'),
    bindings.DB.prepare('DELETE FROM idempotency'),
    bindings.DB.prepare('DELETE FROM sessions'),
    bindings.DB.prepare('DELETE FROM login_attempts'),
    bindings.DB.prepare(
      'UPDATE site SET password_hash=NULL,password_salt=NULL,auth_epoch=0,quota_bytes=8000000000,allocated_bytes=0 WHERE id=1',
    ),
  ]);
  const setup = await request('/api/auth/setup', 'POST', {
    token: bindings.SETUP_TOKEN,
    password: 'Note2026',
  });
  cookie = setup.headers.get('set-cookie')!.split(';')[0];
});
afterEach(async () => {
  await Promise.all(contexts.map(waitOnExecutionContext));
});

const PNG: Uint8Array<ArrayBuffer> = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1]);
async function uploadImage(bytes: Uint8Array<ArrayBuffer> = PNG, keyId?: string, key?: CryptoKey) {
  const body = keyId ? await sealBytes(key!, keyId, bytes) : bytes;
  const query = keyId ? `&key=${keyId}&mime=image%2Fpng` : '';
  const response = await SELF.fetch(
    `https://notes.test/api/files?name=shot.png&size=${body.length}${query}`,
    { method: 'POST', headers: { cookie, origin: 'https://notes.test' }, body },
  );
  expect(response.ok, await response.clone().text()).toBe(true);
  return response.json<{ id: string }>();
}
const add = (text: string, extra: Record<string, unknown> = {}) =>
  ok<Clip>('/api/clips', 'POST', { id: crypto.randomUUID(), text, ...extra });
async function newKey() {
  const key = await newContentKey();
  const salt = newSalt();
  const record = {
    id: crypto.randomUUID(),
    salt,
    iterations: 100_000,
    wrapped: await wrapContentKey(
      await passwordKey('secret-1', salt, 100_000),
      await exportContentKey(key),
    ),
    check_value: await keyCheck(key),
  };
  await ok('/api/encryption/keys', 'POST', record);
  return { id: record.id, key };
}

describe('clips', () => {
  it('lists newest first, pinned apart, and a resent create saves one clip', async () => {
    const id = crypto.randomUUID();
    const first = await ok<Clip>('/api/clips', 'POST', { id, text: '  第一条\r\n第二行 ' });
    expect(first.text).toBe('第一条\n第二行');
    expect(first.pinned).toBe(false);
    const again = await ok<Clip>('/api/clips', 'POST', { id, text: '别的内容' });
    expect(again).toEqual(first);
    const second = await add('第二条', { createdAt: Date.now() + 60_000 });
    // A future time is clamped to now.
    expect(second.created_at).toBeLessThanOrEqual(Date.now());
    await ok(`/api/clips/${first.id}`, 'PATCH', { pinned: true });
    const list = await ok<ClipList>('/api/clips');
    expect(list.pinned.map((clip) => clip.text)).toEqual(['第一条\n第二行']);
    expect(list.items.map((clip) => clip.text)).toEqual(['第二条']);
    expect(list.next).toBeNull();
    expect(list.keyId).toBeNull();
    // Unpinning puts it back on top of the recent ones.
    await ok(`/api/clips/${first.id}`, 'PATCH', { pinned: false });
    expect((await ok<ClipList>('/api/clips')).items.map((clip) => clip.id)).toEqual([
      first.id,
      second.id,
    ]);
    await ok(`/api/clips/${first.id}`, 'DELETE');
    await ok(`/api/clips/${first.id}`, 'DELETE');
    expect((await ok<ClipList>('/api/clips')).items.map((clip) => clip.id)).toEqual([second.id]);
  });

  it('stops pinning at the limit and still unpins', async () => {
    const now = Date.now();
    await bindings.DB.batch(
      Array.from({ length: CLIP_PINNED }, (_, index) =>
        bindings.DB.prepare('INSERT INTO clips(id,text,pinned,created_at) VALUES(?,?,1,?)').bind(
          `p${index}`,
          `置顶 ${index}`,
          now - 1000 + index,
        ),
      ),
    );
    const extra = await add('多出来的');
    const refused = await request(`/api/clips/${extra.id}`, 'PATCH', { pinned: true });
    expect(refused.status).toBe(400);
    // Pinning a pinned clip again is not a new pin.
    expect((await ok<Clip>('/api/clips/p0', 'PATCH', { pinned: true })).pinned).toBe(true);
    const unpinned = await ok<Clip>('/api/clips/p0', 'PATCH', { pinned: false });
    expect(unpinned.pinned).toBe(false);
    expect(unpinned.created_at).toBeGreaterThan(now - 1000);
    expect((await ok<Clip>(`/api/clips/${extra.id}`, 'PATCH', { pinned: true })).pinned).toBe(true);
  });

  it('refuses empty or oversized text and unknown clips', async () => {
    expect((await request('/api/clips', 'POST', { id: crypto.randomUUID(), text: ' \n ' })).status).toBe(400);
    expect(
      (await request('/api/clips', 'POST', { id: crypto.randomUUID(), text: '字'.repeat(10_001) }))
        .status,
    ).toBe(413);
    expect((await request('/api/clips', 'POST', { id: 'bad id', text: '内容' })).status).toBe(400);
    expect((await request(`/api/clips/${crypto.randomUUID()}`, 'PATCH', { pinned: true })).status).toBe(404);
    expect((await request('/api/clips?before=nope')).status).toBe(400);
  });

  it('pages through older clips and keeps only the newest unpinned ones', async () => {
    const now = Date.now();
    const rows = Array.from({ length: CLIP_KEEP + 3 }, (_, index) =>
      bindings.DB.prepare('INSERT INTO clips(id,text,pinned,created_at) VALUES(?,?,0,?)').bind(
        `c${String(index).padStart(4, '0')}`,
        `第 ${index} 条`,
        now - 100_000 + index,
      ),
    );
    await bindings.DB.batch(rows);
    await bindings.DB.prepare("UPDATE clips SET pinned=1 WHERE id='c0000'").run();
    // Cleanup trims the oldest unpinned ones; a pinned one is kept however old.
    const latest = await add('最新');
    await cleanup(bindings);
    const seen: string[] = [];
    let list = await ok<ClipList>('/api/clips');
    expect(list.items).toHaveLength(CLIP_PAGE);
    expect(list.items[0].id).toBe(latest.id);
    expect(list.pinned.map((clip) => clip.id)).toEqual(['c0000']);
    seen.push(...list.items.map((clip) => clip.id));
    while (list.next) {
      list = await ok<ClipList>(`/api/clips?before=${list.next}`);
      expect(list.pinned).toEqual([]);
      seen.push(...list.items.map((clip) => clip.id));
    }
    expect(seen).toHaveLength(CLIP_KEEP);
    expect(new Set(seen).size).toBe(CLIP_KEEP);
    expect(seen).not.toContain('c0001');
    expect(seen.at(-1)).toBe(`c${String(CLIP_KEEP + 3 - CLIP_KEEP + 1).padStart(4, '0')}`);
  });

  it('names its source page while it is outside the trash', async () => {
    const note = await ok<NoteNode>('/api/nodes', 'POST', {
      kind: 'markdown',
      title: '读书笔记',
      content: '正文',
    });
    const clip = await add('摘一句', { sourceId: note.id });
    expect(clip.source_title).toBe('读书笔记');
    await ok(`/api/nodes/${note.id}`, 'DELETE', { count: 1 });
    const [listed] = (await ok<ClipList>('/api/clips')).items;
    expect(listed.source_id).toBe(note.id);
    expect(listed.source_title).toBeNull();
  });

  it('seals new clips with the clip key once set, and re-seals existing ones', async () => {
    const plain = await add('明文');
    const { id, key } = await newKey();
    // Every clip must come sealed for the new key.
    const mismatch = await request('/api/clips/encryption', 'PUT', {
      keyId: id,
      items: [{ id: plain.id, text: '明文' }],
    });
    expect(mismatch.status).toBe(409);
    expect((await mismatch.json<{ code: string }>()).code).toBe('ENCRYPTION_CHANGED');
    const result = await ok<{ remaining: number }>('/api/clips/encryption', 'PUT', {
      keyId: id,
      items: [{ id: plain.id, text: await sealText(key, id, '明文') }],
    });
    expect(result.remaining).toBe(0);
    expect(await ok<{ keyId: string | null }>('/api/clips/key')).toEqual({ keyId: id });
    // A device that still thinks clips are plain learns otherwise.
    const refused = await request('/api/clips', 'POST', { id: crypto.randomUUID(), text: '新的' });
    expect(refused.status).toBe(409);
    expect((await refused.json<{ code: string }>()).code).toBe('ENCRYPTION_CHANGED');
    const other = await newKey();
    expect(
      (
        await request('/api/clips', 'POST', {
          id: crypto.randomUUID(),
          text: await sealText(other.key, other.id, '别的钥匙'),
        })
      ).status,
    ).toBe(409);
    const sealed = await add(await sealText(key, id, '新的'));
    expect(sealed.key_id).toBe(id);
    const list = await ok<ClipList>('/api/clips');
    expect(list.keyId).toBe(id);
    expect(await Promise.all(list.items.map((clip) => openText(key, clip.text)))).toEqual([
      '新的',
      '明文',
    ]);
    // And back to plain text.
    const back = await ok<{ remaining: number }>('/api/clips/encryption', 'PUT', {
      keyId: null,
      items: [
        { id: sealed.id, text: '新的' },
        { id: plain.id, text: '明文' },
      ],
    });
    expect(back.remaining).toBe(0);
    expect((await ok<ClipList>('/api/clips')).items.map((clip) => [clip.text, clip.key_id])).toEqual([
      ['新的', null],
      ['明文', null],
    ]);
    expect(
      (await request('/api/clips/encryption', 'PUT', { keyId: crypto.randomUUID(), items: [] }))
        .status,
    ).toBe(404);
  });

  it('keeps an image, with or without text, and leaves it to cleanup once deleted', async () => {
    const image = await uploadImage();
    const clip = await add('', { blobId: image.id });
    expect(clip.text).toBe('');
    expect(clip.file).toMatchObject({ id: image.id, mime: 'image/png', key_id: null });
    expect((await ok<ClipList>('/api/clips')).items[0].file?.id).toBe(image.id);
    // Text alone may not be empty, and an image must be a picture that exists.
    expect((await request('/api/clips', 'POST', { id: crypto.randomUUID(), text: '' })).status).toBe(400);
    const pdf = new TextEncoder().encode('%PDF-1.4\n%%EOF');
    const document = await (
      await SELF.fetch(`https://notes.test/api/files?name=a.pdf&size=${pdf.length}`, {
        method: 'POST',
        headers: { cookie, origin: 'https://notes.test' },
        body: pdf,
      })
    ).json<{ id: string }>();
    expect(
      (await request('/api/clips', 'POST', { id: crypto.randomUUID(), text: 'x', blobId: document.id }))
        .status,
    ).toBe(400);
    expect(
      (await request('/api/clips', 'POST', { id: crypto.randomUUID(), text: 'x', blobId: 'missing' }))
        .status,
    ).toBe(404);
    // Referenced, the image survives cleanup; deleted, it goes.
    await bindings.DB.prepare('UPDATE blobs SET draft_until=0 WHERE id=?').bind(document.id).run();
    await cleanup(bindings);
    expect(await bindings.DB.prepare('SELECT 1 FROM blobs WHERE id=?').bind(image.id).first()).not.toBeNull();
    await ok(`/api/clips/${clip.id}`, 'DELETE');
    await cleanup(bindings);
    expect(await bindings.DB.prepare('SELECT 1 FROM blobs WHERE id=?').bind(image.id).first()).toBeNull();
  });

  it('seals images with the clip key and re-seals them in place', async () => {
    const { id, key } = await newKey();
    await ok('/api/clips/encryption', 'PUT', { keyId: id, items: [] });
    // A plain image does not go into encrypted clips.
    const plain = await uploadImage();
    const refused = await request('/api/clips', 'POST', {
      id: crypto.randomUUID(),
      text: '',
      blobId: plain.id,
    });
    expect((await refused.json<{ code: string }>()).code).toBe('ENCRYPTION_CHANGED');
    const sealed = await uploadImage(PNG, id, key);
    const clip = await add('', { blobId: sealed.id });
    expect(clip.file?.key_id).toBe(id);
    // Back to plain: the text batch, then the image replaced under the same ID.
    const switched = await ok<{ remaining: number }>('/api/clips/encryption', 'PUT', {
      keyId: null,
      items: [{ id: clip.id, text: '' }],
    });
    expect(switched.remaining).toBe(1);
    const wrong = await SELF.fetch(`https://notes.test/api/clips/objects/${sealed.id}`, {
      method: 'PUT',
      headers: { cookie, origin: 'https://notes.test' },
      body: await sealBytes(key, id, PNG),
    });
    expect(wrong.status).toBe(409);
    const replaced = await SELF.fetch(`https://notes.test/api/clips/objects/${sealed.id}`, {
      method: 'PUT',
      headers: { cookie, origin: 'https://notes.test' },
      body: PNG,
    });
    expect(replaced.ok, await replaced.clone().text()).toBe(true);
    const [listed] = (await ok<ClipList>('/api/clips')).items;
    expect(listed.file).toMatchObject({ id: sealed.id, key_id: null });
    const served = await SELF.fetch(`https://notes.test/api/files/${sealed.id}`, {
      headers: { cookie },
    });
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
    expect(
      (await ok<{ remaining: number }>('/api/clips/encryption', 'PUT', { keyId: null, items: [] }))
        .remaining,
    ).toBe(0);
    // Only clip images can be replaced here.
    expect(
      (
        await SELF.fetch(`https://notes.test/api/clips/objects/${plain.id}`, {
          method: 'PUT',
          headers: { cookie, origin: 'https://notes.test' },
          body: PNG,
        })
      ).status,
    ).toBe(404);
  });

  it('goes into backups and is restored once, with its source remapped', async () => {
    const note = await ok<NoteNode>('/api/nodes', 'POST', {
      kind: 'markdown',
      title: '来源',
      content: '正文',
    });
    const image = await uploadImage();
    const clip = await add('备份里的随手记', { sourceId: note.id, blobId: image.id });
    await ok(`/api/clips/${clip.id}`, 'PATCH', { pinned: true });
    const snapshot = await ok<{ archive: LibraryBackup }>('/api/backups', 'POST', {});
    expect(snapshot.archive.tables.clips).toHaveLength(1);
    const restore = async () => {
      const stage = await ok<{ id: string }>('/api/backups/restore', 'POST', snapshot.archive);
      for (const file of snapshot.archive.files) {
        const object = await bindings.FILES.get(
          (await bindings.DB.prepare('SELECT object_key FROM blobs WHERE id=?')
            .bind(file.id)
            .first<{ object_key: string }>())!.object_key,
        );
        const response = await SELF.fetch(
          `https://notes.test/api/backups/${stage.id}/files/${file.id}`,
          {
            method: 'POST',
            headers: { cookie, origin: 'https://notes.test' },
            body: await object!.arrayBuffer(),
          },
        );
        expect(response.ok, await response.clone().text()).toBe(true);
      }
      return ok<{ rootId: string }>(`/api/backups/${stage.id}/commit`, 'POST', {});
    };
    // Into the same library: the clip is already there.
    await restore();
    let list = await ok<ClipList>('/api/clips');
    expect(list.pinned.map((item) => [item.id, item.source_id])).toEqual([[clip.id, note.id]]);
    // Without it, it comes back pointing at the restored copy of its page.
    await bindings.DB.prepare('DELETE FROM clips').run();
    const { rootId } = await restore();
    list = await ok<ClipList>('/api/clips');
    expect(list.pinned).toHaveLength(1);
    const copy = (await ok<{ nodes: NoteNode[] }>(`/api/nodes?parent=${rootId}`)).nodes.find(
      (node) => node.title === '来源',
    )!;
    expect(list.pinned[0].source_id).toBe(copy.id);
    expect(list.pinned[0].text).toBe('备份里的随手记');
    // Its image is the restored copy.
    expect(list.pinned[0].file?.id).toBeTruthy();
    expect(list.pinned[0].file?.id).not.toBe(image.id);
    const served = await SELF.fetch(`https://notes.test/api/files/${list.pinned[0].file!.id}`, {
      headers: { cookie },
    });
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
  });
});
