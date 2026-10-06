/// <reference types="@cloudflare/vitest-pool-workers/types" />
import {
  env,
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../worker/index';
import type { Env } from '../worker/types';
import type { FileInfo, NoteDetail, NoteNode } from '../shared/types';
import type { AnnotationList } from '../shared/annotations';
import {
  DecryptionError,
  exportContentKey,
  fromBase64Url,
  keyCheck,
  keyChain,
  newContentKey,
  newSalt,
  openBytes,
  openText,
  passwordKey,
  plainSize,
  sealBytes,
  sealedKeyId,
  sealedSize,
  sealedTextKeyId,
  sealText,
  toBase64Url,
  unwrapContentKey,
  wrapContentKey,
  type EncryptionPlan,
} from '../shared/encryption';

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
let cookie = '';
let contexts: ExecutionContext[] = [];
beforeAll(() => applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS));
async function request(
  path: string,
  method = 'GET',
  data?: unknown,
  headers: Record<string, string> = {},
) {
  const context = createExecutionContext();
  contexts.push(context);
  const raw = data instanceof Uint8Array;
  return worker.fetch(
    new Request(`https://notes.test${path}`, {
      method,
      headers: {
        origin: 'https://notes.test',
        ...(raw ? {} : { 'content-type': 'application/json' }),
        cookie,
        'x-idempotency-key': crypto.randomUUID(),
        ...headers,
      },
      body: data === undefined ? undefined : raw ? new Uint8Array(data) : JSON.stringify(data),
    }),
    bindings,
    context,
  );
}
async function ok<T = Record<string, unknown>>(
  path: string,
  method = 'GET',
  data?: unknown,
  headers?: Record<string, string>,
) {
  const response = await request(path, method, data, headers);
  expect(response.ok, await response.clone().text()).toBe(true);
  return response.json() as Promise<T>;
}
// A key as a device creates it (fewer iterations than the app, for speed).
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
  const header = { 'x-note-keys': `${record.id}.${toBase64Url(await exportContentKey(key))}` };
  return { id: record.id, key, record, header };
}
async function uploadSealed(
  key: CryptoKey,
  keyId: string,
  text: string,
  mime = 'text/plain; charset=utf-8',
) {
  const sealed = await sealBytes(key, keyId, new TextEncoder().encode(text));
  return ok<FileInfo>(
    `/api/files?name=content.txt&size=${sealed.length}&key=${keyId}&mime=${encodeURIComponent(mime)}`,
    'POST',
    sealed,
  );
}
async function encryptedFolder() {
  const folder = await ok<NoteNode>('/api/nodes', 'POST', { kind: 'folder', title: '日记' });
  const key = await newKey();
  await ok(`/api/nodes/${folder.id}/encryption`, 'PUT', { encryption: key.id });
  return { folder, ...key };
}
beforeEach(async () => {
  contexts = [];
  cookie = '';
  await bindings.DB.batch([
    bindings.DB.prepare('DELETE FROM nodes'),
    bindings.DB.prepare('DELETE FROM trash_batches'),
    bindings.DB.prepare('DELETE FROM blobs'),
    bindings.DB.prepare('DELETE FROM encryption_keys'),
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
  const setup = await request('/api/auth/setup', 'POST', {
    token: bindings.SETUP_TOKEN,
    password: 'Note2026',
  });
  cookie = setup.headers.get('set-cookie')!.split(';')[0];
});
afterEach(async () => {
  await Promise.all(contexts.map(waitOnExecutionContext));
});

describe('sealed format', () => {
  it('round-trips across chunks and refuses tampering', async () => {
    const key = await newContentKey();
    const id = crypto.randomUUID();
    const plain = crypto.getRandomValues(new Uint8Array(65_536 * 2 + 17));
    const sealed = await sealBytes(key, id, plain);
    expect(sealed.length).toBe(sealedSize(plain.length));
    expect(plainSize(sealed.length)).toBe(plain.length);
    expect(sealedKeyId(sealed)).toBe(id);
    expect(await openBytes(key, sealed)).toEqual(plain);
    const flipped = sealed.slice();
    flipped[100] ^= 1;
    await expect(openBytes(key, flipped)).rejects.toBeInstanceOf(DecryptionError);
    // Dropping the last chunk is caught by the final-chunk flag.
    await expect(openBytes(key, sealed.slice(0, 48 + 2 * (65_536 + 16)))).rejects.toBeInstanceOf(
      DecryptionError,
    );
    const empty = await sealBytes(key, id, new Uint8Array());
    expect(await openBytes(key, empty)).toEqual(new Uint8Array());
    const text = await sealText(key, id, '摘要');
    expect(sealedTextKeyId(text)).toBe(id);
    expect(await openText(key, text)).toBe('摘要');
  });
  it('unwraps only with the right password', async () => {
    const salt = newSalt();
    const raw = await exportContentKey(await newContentKey());
    const wrapped = await wrapContentKey(await passwordKey('right', salt, 100_000), raw);
    expect(await unwrapContentKey(await passwordKey('right', salt, 100_000), wrapped)).toEqual(raw);
    await expect(
      unwrapContentKey(await passwordKey('wrong', salt, 100_000), wrapped),
    ).rejects.toBeInstanceOf(DecryptionError);
  });
  it('follows inheritance along a path', () => {
    expect(
      keyChain([
        { encryption: 'a' },
        { encryption: null },
        { encryption: 'none' },
        { encryption: 'b' },
      ]),
    ).toEqual(['a', 'b']);
  });
});

describe('encrypted notes', () => {
  it('stores bodies sealed on the device and never accepts plain text there', async () => {
    const { folder, id, key } = await encryptedFolder();
    const refused = await request('/api/nodes', 'POST', {
      kind: 'markdown',
      parentId: folder.id,
      content: '秘密',
    });
    expect(refused.status).toBe(409);
    expect((await refused.json<{ code: string }>()).code).toBe('ENCRYPTION_CHANGED');

    const body = await uploadSealed(key, id, '# 标题\n\n秘密');
    expect(body.key_id).toBe(id);
    const title = await sealText(key, id, '标题');
    const note = await ok<NoteNode>('/api/nodes', 'POST', {
      kind: 'markdown',
      parentId: folder.id,
      bodyBlobId: body.id,
      attachments: [],
      metadata: { title },
    });
    expect(note.key_id).toBe(id);
    expect(note.metadata_title).toBe(title);
    const detail = await ok<NoteDetail>(`/api/nodes/${note.id}`);
    expect(detail.content).toBe('');
    expect(detail.breadcrumbs.map((part) => part.encryption)).toEqual([id, null]);
    const opened = await openBytes(key, fromBase64Url(detail.sealed!));
    expect(new TextDecoder().decode(opened)).toBe('# 标题\n\n秘密');
    const stored = await bindings.FILES.get(`objects/${body.id}`);
    expect(new TextDecoder().decode(await stored!.arrayBuffer())).not.toContain('秘密');

    // A child may opt out.
    const plain = await ok<NoteNode>('/api/nodes', 'POST', {
      kind: 'folder',
      parentId: folder.id,
      title: '公开',
    });
    await ok(`/api/nodes/${plain.id}/encryption`, 'PUT', { encryption: 'none' });
    const open = await ok<NoteNode>('/api/nodes', 'POST', {
      kind: 'text',
      parentId: plain.id,
      content: '公开内容',
    });
    expect(open.key_id).toBeNull();
    expect((await ok<NoteDetail>(`/api/nodes/${open.id}`)).content).toBe('公开内容');
    // Sealed text is refused in a plain place.
    const misplaced = await uploadSealed(key, id, 'x');
    const wrong = await request('/api/nodes', 'POST', {
      kind: 'text',
      parentId: plain.id,
      bodyBlobId: misplaced.id,
    });
    expect(wrong.status).toBe(409);
  });
  it('checks sealed uploads and serves them as opaque bytes', async () => {
    const { id, key } = await encryptedFolder();
    const other = crypto.randomUUID();
    const sealed = await sealBytes(key, other, new TextEncoder().encode('x'));
    const mismatch = await request(
      `/api/files?name=a.txt&size=${sealed.length}&key=${id}&mime=text%2Fplain`,
      'POST',
      sealed,
    );
    expect(mismatch.status).toBe(400);
    const file = await uploadSealed(key, id, 'hello', 'image/png');
    const served = await request(`/api/files/${file.id}`);
    expect(served.headers.get('content-type')).toBe('application/octet-stream');
    expect(served.headers.get('x-note-key')).toBe(id);
    expect(served.headers.get('content-disposition')).toMatch(/^attachment/);
  });
  it('gives the Worker the key only with the request that needs it', async () => {
    const { folder, id, key, header } = await encryptedFolder();
    const body = await uploadSealed(key, id, '正文');
    const note = await ok<NoteNode>('/api/nodes', 'POST', {
      kind: 'text',
      parentId: folder.id,
      bodyBlobId: body.id,
    });
    expect((await request(`/api/nodes/${note.id}/assistant`)).status).toBe(423);
    expect(
      (await ok(`/api/nodes/${note.id}/assistant`, 'GET', undefined, header)).messages,
    ).toEqual([]);
    const bad = await request(`/api/nodes/${note.id}/assistant`, 'GET', undefined, {
      'x-note-keys': `${id}.${toBase64Url(await exportContentKey(await newContentKey()))}`,
    });
    expect(bad.status).toBe(400);
    expect(await ok(`/api/nodes/${note.id}/keys`)).toEqual({ key_id: id, chain: [id] });
  });
  it('keeps encrypted highlights out of the search index', async () => {
    const { folder, id, key } = await encryptedFolder();
    const body = await uploadSealed(key, id, '正文');
    const note = await ok<NoteNode>('/api/nodes', 'POST', {
      kind: 'text',
      parentId: folder.id,
      bodyBlobId: body.id,
    });
    // The Worker cannot write a plain list for an encrypted note.
    expect(
      (
        await request(`/api/nodes/${note.id}/annotations/a1`, 'PUT', {
          quote: '正文',
          note: '',
          location: { kind: 'text', start: 0, end: 2, exact: '正文', prefix: '', suffix: '' },
        })
      ).status,
    ).toBe(423);
    const first = await uploadSealed(key, id, JSON.stringify({ annotations: [{ id: 'a1' }] }));
    const saved = await ok<AnnotationList>(`/api/nodes/${note.id}/annotations`, 'PUT', {
      bodyBlobId: first.id,
      previous: null,
    });
    const list = await ok<AnnotationList>(`/api/nodes/${note.id}/annotations`);
    expect(list.body).toBe(saved.body);
    expect(list.sealed).toBeTruthy();
    // A save based on an older list is refused.
    const second = await uploadSealed(key, id, JSON.stringify({ annotations: [] }));
    const stale = await request(`/api/nodes/${note.id}/annotations`, 'PUT', {
      bodyBlobId: second.id,
      previous: null,
    });
    expect((await stale.json<{ code: string }>()).code).toBe('ANNOTATIONS_CHANGED');
    const row = await bindings.DB.prepare('SELECT search_text FROM annotations WHERE node_id=?')
      .bind(note.id)
      .first<{ search_text: string }>();
    expect(row!.search_text).toBe('');
  });
  it('re-encrypts existing content in place', async () => {
    const folder = await ok<NoteNode>('/api/nodes', 'POST', { kind: 'folder', title: '旧笔记' });
    const note = await ok<NoteNode>('/api/nodes', 'POST', {
      kind: 'markdown',
      parentId: folder.id,
      content: '---\nstatus: done\n---\n旧内容',
    });
    const { id, key } = await newKey();
    await ok(`/api/nodes/${folder.id}/encryption`, 'PUT', { encryption: id });
    const plan = await ok<EncryptionPlan>(`/api/nodes/${folder.id}/encryption/plan`);
    expect(plan.objects).toHaveLength(1);
    const [object] = plan.objects;
    expect(object).toMatchObject({ kind: 'body', target: id, key_id: null, current: 1 });
    const plain = await request(`/api/files/${object.id}`);
    const sealed = await sealBytes(key, id, new Uint8Array(await plain.arrayBuffer()));
    // The wrong key (or none) is refused.
    expect(
      (
        await request(
          `/api/nodes/${folder.id}/encryption/objects/${object.id}`,
          'PUT',
          new TextEncoder().encode('plain'),
        )
      ).status,
    ).toBe(409);
    await ok(`/api/nodes/${folder.id}/encryption/objects/${object.id}`, 'PUT', sealed);
    await ok(`/api/nodes/${folder.id}/encryption/fields`, 'POST', {
      fields: [
        {
          table: 'nodes',
          node_id: note.id,
          version_id: object.version_id,
          status: await sealText(key, id, 'done'),
        },
      ],
    });
    expect((await ok<EncryptionPlan>(`/api/nodes/${folder.id}/encryption/plan`)).objects).toEqual(
      [],
    );
    const detail = await ok<NoteDetail>(`/api/nodes/${note.id}`);
    expect(detail.sealed).toBeTruthy();
    expect(sealedTextKeyId(detail.metadata_status)).toBe(id);
    const site = await bindings.DB.prepare('SELECT allocated_bytes FROM site WHERE id=1').first<{
      allocated_bytes: number;
    }>();
    const blobs = await bindings.DB.prepare('SELECT SUM(size) size FROM blobs').first<{
      size: number;
    }>();
    expect(site!.allocated_bytes).toBe(blobs!.size);
    expect((await bindings.FILES.list()).objects).toHaveLength(1);
  });
});
