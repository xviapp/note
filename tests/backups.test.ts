import { GLOBAL_ASSISTANT_ID, type ChatHistory } from '../shared/assistant';
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, SELF, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import type { Env } from '../worker/types';
import type { NoteDetail, NoteNode } from '../shared/types';
import type { AnnotationList } from '../shared/annotations';
import type { LibraryBackup } from '../shared/backup';
import { createNode } from '../worker/library';
import { readText, storeChatBody, storeText, uploadFile } from '../worker/storage';
import { cleanup, purgeTrash, trashNode } from '../worker/recovery';
import { startRestore, finishRestore } from '../worker/backups';

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
let cookie = '';
beforeAll(() => applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS));
const request = (
  path: string,
  method = 'GET',
  data?: unknown,
  extra: Record<string, string> = {},
) =>
  SELF.fetch(`https://notes.test${path}`, {
    method,
    headers: { cookie, origin: 'https://notes.test', 'content-type': 'application/json', ...extra },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
async function ok<T = Record<string, unknown>>(
  path: string,
  method = 'GET',
  data?: unknown,
  extra = {},
): Promise<T> {
  const response = await request(path, method, data, extra);
  expect(response.ok, await response.clone().text()).toBe(true);
  return response.json() as Promise<T>;
}
beforeEach(async () => {
  await bindings.DB.batch(
    [
      'DELETE FROM backup_jobs',
      'DELETE FROM backup_restore_nodes',
      'DELETE FROM assistant_threads',
      'DELETE FROM nodes',
      'DELETE FROM trash_batches',
      'DELETE FROM blobs',
      'DELETE FROM idempotency',
      'DELETE FROM sessions',
      'DELETE FROM login_attempts',
      'UPDATE site SET password_hash=NULL,password_salt=NULL,auth_epoch=0,quota_bytes=8000000000,allocated_bytes=0 WHERE id=1',
    ].map((q) => bindings.DB.prepare(q)),
  );
  cookie = '';
  const login = await request('/api/auth/setup', 'POST', {
    token: bindings.SETUP_TOKEN,
    password: 'Backup2026',
  });
  expect(login.status).toBe(200);
  cookie = login.headers.get('set-cookie')!.split(';')[0];
});
const create = (data: object) => ok<NoteNode>('/api/nodes', 'POST', data);
async function file(name: string, content: string) {
  const data = new TextEncoder().encode(content);
  return uploadFile(
    bindings,
    new Request(`https://notes.test/api/files?name=${name}&size=${data.length}`, {
      method: 'POST',
      body: data,
    }),
  );
}
async function uploadArchive(job: string, archive: LibraryBackup) {
  for (const file of archive.files) {
    const original = await bindings.FILES.get(
      (await bindings.DB.prepare('SELECT object_key FROM blobs WHERE id=?')
        .bind(file.id)
        .first<{ object_key: string }>())!.object_key,
    );
    const response = await SELF.fetch(`https://notes.test/api/backups/${job}/files/${file.id}`, {
      method: 'POST',
      headers: { cookie, origin: 'https://notes.test' },
      body: await original!.arrayBuffer(),
    });
    expect(response.ok, await response.clone().text()).toBe(true);
  }
}
it('restores a book cover with its remapped file reference', async () => {
  const book = await create({ kind: 'folder', title: '量子力学', book: {} });
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1]);
  const cover = await uploadFile(bindings, new Request(`https://notes.test/api/files?name=cover.png&size=${bytes.length}`, { method: 'POST', body: bytes }));
  await ok(`/api/nodes/${book.id}/book`, 'PUT', { coverId: cover.id });
  const snapshot = await ok<{ archive: LibraryBackup }>('/api/backups', 'POST', {});
  const stage = await ok<{ id: string }>('/api/backups/restore', 'POST', snapshot.archive);
  await uploadArchive(stage.id, snapshot.archive);
  const { rootId } = await ok<{ rootId: string }>(`/api/backups/${stage.id}/commit`, 'POST', {});
  const restored = (await ok<{ nodes: NoteNode[] }>(`/api/nodes?parent=${rootId}`)).nodes.find((node) => node.title === '量子力学')!;
  const detail = await ok<NoteDetail>(`/api/nodes/${restored.id}`);
  expect(detail.book!.cover_blob_id).toBeTruthy();
  expect(detail.book!.cover_blob_id).not.toBe(cover.id);
  const image = await request(`/api/files/${detail.book!.cover_blob_id}`);
  expect(image.headers.get('content-type')).toBe('image/png');
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytes);
});
it('round-trips the whole library, versions, paper assets, chats and translation anchors into a new tree', async () => {
  const folder = await create({ kind: 'folder', title: '论文', icon: { emoji: '📚' } });
  const iconBytes = Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1,
  ]);
  const icon = await uploadFile(
    bindings,
    new Request(`https://notes.test/api/files?name=icon.png&size=${iconBytes.length}`, {
      method: 'POST',
      body: iconBytes,
    }),
  );
  await create({
    kind: 'folder',
    title: '图片目录',
    parentId: folder.id,
    icon: { fileId: icon.id },
  });
  const pdf = await file('paper.pdf', '%PDF-1.4\n%%EOF');
  const pdfNode = await create({
    kind: 'pdf',
    title: '论文 PDF',
    parentId: folder.id,
    fileId: pdf.id,
  });
  const note = await create({
    kind: 'markdown',
    title: '心得',
    parentId: pdfNode.id,
    content: `旧版 [PDF](/api/files/${pdf.id})`,
  });
  const { token } = await ok<{ token: string }>('/api/edit/unlock', 'POST', { nodeId: note.id });
  await ok(
    `/api/nodes/${note.id}/content`,
    'PUT',
    { revision: note.revision, content: `新版 [PDF](/api/files/${pdf.id})`, attachments: [pdf.id] },
    { 'x-note-edit': token },
  );
  const paper = await createNode(
    bindings,
    {
      kind: 'link',
      title: '导入论文',
      url: 'https://arxiv.org/html/2501.00001v1',
      parentId: folder.id,
    },
    crypto.randomUUID(),
    {
      arxivId: '2501.00001v1',
      html: '<article><h2 id="section">论文正文</h2></article>',
      assets: [pdf.id],
    },
  );
  const old = await create({ kind: 'text', title: '回收资料', content: '仍然需要备份' });
  await trashNode(bindings, old.id, 1);
  const userBody = await storeChatBody(
    bindings,
    JSON.stringify({
      content: '解释一下',
      files: [{ source: { id: pdf.id, name: 'paper.pdf' }, text: '原文' }],
    }),
  );
  const answer = await storeText(bindings, JSON.stringify({ content: '解释正文' }));
  const translation = await storeText(
    bindings,
    JSON.stringify({
      source: 'original',
      content: '译文',
      location: {
        kind: 'pdf',
        fileId: pdf.id,
        page: 1,
        endPage: 1,
        rects: [{ page: 1, x: 0, y: 0, width: 0.5, height: 0.1 }],
      },
    }),
  );
  const notes = await storeText(
    bindings,
    JSON.stringify({ annotations: [{ id: 'a1', quote: '新版', note: '记得复习' }] }),
  );
  const messageId = crypto.randomUUID();
  await bindings.DB.batch([
    bindings.DB.prepare(
      'INSERT INTO annotations(node_id,body_blob_id,updated_at) VALUES(?,?,1)',
    ).bind(note.id, notes.id),
    bindings.DB.prepare('INSERT INTO assistant_threads(node_id) VALUES(?)').bind(pdfNode.id),
    bindings.DB.prepare(
      "INSERT INTO assistant_messages(id,node_id,request_id,role,status,body_blob_id,created_at) VALUES(?,?,?,'user','completed',?,1)",
    ).bind(messageId, pdfNode.id, 'request', userBody.id),
    bindings.DB.prepare(
      "INSERT INTO assistant_messages(id,node_id,request_id,role,status,body_blob_id,exported_node_id,created_at) VALUES(?,?,?,'assistant','completed',?,?,2)",
    ).bind(crypto.randomUUID(), pdfNode.id, 'request', answer.id, note.id),
    bindings.DB.prepare('INSERT INTO assistant_message_files(message_id,blob_id) VALUES(?,?)').bind(
      messageId,
      pdf.id,
    ),
    bindings.DB.prepare(
      "INSERT INTO translations(id,node_id,source_hash,target_language,excerpt,body_blob_id,updated_at) VALUES(?,?,?,'zh-CN','original',?,1)",
    ).bind(crypto.randomUUID(), pdfNode.id, 'a'.repeat(64), translation.id),
    bindings.DB.prepare('INSERT INTO favorites(node_id,created_at) VALUES(?,1)').bind(note.id),
    bindings.DB.prepare(
      'INSERT INTO reading_states(node_id,position,version,last_opened_at,updated_at) VALUES(?,?,1,1,1)',
    ).bind(pdfNode.id, JSON.stringify({ page: 1, pageRatio: 0.4 })),
    bindings.DB.prepare(
      'INSERT INTO reading_states(node_id,position,version,last_opened_at,updated_at) VALUES(?,?,1,1,1)',
    ).bind(paper.id, JSON.stringify({ heading: `paper-${paper.id}-section`, headingRatio: 0.25 })),
  ]);
  const snapshot = await ok<{ id: string; archive: LibraryBackup }>('/api/backups', 'POST', {});
  expect(Object.keys(snapshot.archive.tables)).not.toContain('sessions');
  expect(JSON.stringify(snapshot.archive)).not.toContain('password_hash');
  const key = crypto.randomUUID();
  const stage = await ok<{ id: string }>('/api/backups/restore', 'POST', snapshot.archive, {
    'x-idempotency-key': key,
  });
  expect((await request(`/api/backups/${stage.id}/commit`, 'POST', {})).status).toBe(409);
  await uploadArchive(stage.id, snapshot.archive);
  const { rootId } = await ok<{ rootId: string }>(`/api/backups/${stage.id}/commit`, 'POST', {});
  expect(await ok(`/api/backups/${stage.id}/commit`, 'POST', {})).toEqual({ rootId });
  expect(
    await ok('/api/backups/restore', 'POST', snapshot.archive, { 'x-idempotency-key': key }),
  ).toEqual({ id: key, rootId });
  const restoredFolder = (
    await ok<{ nodes: NoteNode[] }>(`/api/nodes?parent=${rootId}`)
  ).nodes.find((n) => n.title === '论文')!;
  expect(restoredFolder.icon_emoji).toBe('📚');
  const children = (await ok<{ nodes: NoteNode[] }>(`/api/nodes?parent=${restoredFolder.id}`))
    .nodes;
  const restoredPdf = children.find((n) => n.kind === 'pdf')!;
  const restoredIcon = children.find((n) => n.title === '图片目录')!.icon_blob_id;
  expect(restoredIcon).toBeTruthy();
  expect(restoredIcon).not.toBe(icon.id);
  expect(new Uint8Array(await (await request(`/api/files/${restoredIcon}`)).arrayBuffer())).toEqual(
    iconBytes,
  );
  expect(restoredPdf.file_blob_id).not.toBe(pdf.id);
  const restoredNote = (await ok<{ nodes: NoteNode[] }>(`/api/nodes?parent=${restoredPdf.id}`))
    .nodes[0];
  const detail = await ok<NoteDetail>(`/api/nodes/${restoredNote.id}`);
  expect(detail.content).toBe(`新版 [PDF](/api/files/${restoredPdf.file_blob_id})`);
  expect(detail.favorite).toBe(1);
  expect(
    (await ok<AnnotationList>(`/api/nodes/${detail.id}/annotations`)).annotations[0].note,
  ).toBe('记得复习');
  expect(
    (await ok<{ versions: unknown[] }>(`/api/nodes/${detail.id}/versions`)).versions,
  ).toHaveLength(2);
  const restoredPaper = children.find((n) => n.arxiv_id)!;
  expect((await ok<NoteDetail>(`/api/nodes/${restoredPaper.id}`)).content).toContain('论文正文');
  const reading = await bindings.DB.prepare('SELECT position FROM reading_states WHERE node_id=?')
    .bind(restoredPaper.id)
    .first<{ position: string }>();
  expect(JSON.parse(reading!.position)).toEqual({
    heading: `paper-${restoredPaper.id}-section`,
    headingRatio: 0.25,
  });
  const messages = await bindings.DB.prepare(
    'SELECT * FROM assistant_messages WHERE node_id=? ORDER BY sequence',
  )
    .bind(restoredPdf.id)
    .all<{ body_blob_id: string; exported_node_id: string }>();
  expect(await readText(bindings, messages.results[0].body_blob_id)).toContain(
    restoredPdf.file_blob_id,
  );
  expect(messages.results[1].exported_node_id).toBe(restoredNote.id);
  const translated = await bindings.DB.prepare(
    'SELECT body_blob_id FROM translations WHERE node_id=?',
  )
    .bind(restoredPdf.id)
    .first<{ body_blob_id: string }>();
  expect(JSON.parse(await readText(bindings, translated!.body_blob_id)).location.fileId).toBe(
    restoredPdf.file_blob_id,
  );
  expect((await ok<NoteDetail>(`/api/nodes/${note.id}`)).content).toContain(pdf.id); // Original survives.
  expect(
    (await bindings.DB.prepare('SELECT COUNT(*) count FROM backup_restore_nodes').first<{
      count: number;
    }>())!.count,
  ).toBe(0);
  expect(
    (await ok<{ nodes: NoteNode[] }>(`/api/nodes?parent=${rootId}`)).nodes.some(
      (n) => n.title === '原回收站',
    ),
  ).toBe(true);
});
it('pins snapshot bytes through deletion and cleanup, then releases them', async () => {
  const node = await create({ kind: 'markdown', title: '原文', content: 'snapshot content' });
  const snapshot = await ok<{ id: string; archive: LibraryBackup }>('/api/backups', 'POST', {});
  const batch = await trashNode(bindings, node.id, 1);
  await purgeTrash(bindings, batch.id);
  await cleanup(bindings);
  expect(await (await request(`/api/files/${snapshot.archive.files[0].id}`)).text()).toBe(
    'snapshot content',
  );
  await ok(`/api/backups/${snapshot.id}`, 'DELETE');
  await cleanup(bindings);
  expect((await request(`/api/files/${snapshot.archive.files[0].id}`)).status).toBe(404);
});
it('rejects cyclic or incomplete manifests, requires authentication and rolls back an invalid restore', async () => {
  const note = await create({ kind: 'text', title: '保留', content: 'safe' });
  const { archive } = await ok<{ archive: LibraryBackup }>('/api/backups', 'POST', {});
  expect((await request('/api/backups', 'POST', {}, { cookie: '' })).status).toBe(401);
  const cyclic = structuredClone(archive);
  cyclic.tables.nodes[0].parent_id = note.id;
  expect((await request('/api/backups/restore', 'POST', cyclic)).status).toBe(400);
  const missing = structuredClone(archive);
  missing.files = [];
  expect((await request('/api/backups/restore', 'POST', missing)).status).toBe(400);
  const badPosition = structuredClone(archive);
  badPosition.tables.reading_states = [
    { node_id: note.id, position: '{"page":-1}', version: 0, last_opened_at: 1, updated_at: 1 },
  ];
  expect((await request('/api/backups/restore', 'POST', badPosition)).status).toBe(400);
  const broken = structuredClone(archive);
  broken.tables.favorites = [
    { node_id: note.id, created_at: 1 },
    { node_id: note.id, created_at: 2 },
  ];
  const stage = await ok<{ id: string }>('/api/backups/restore', 'POST', broken);
  await uploadArchive(stage.id, broken);
  expect((await request(`/api/backups/${stage.id}/commit`, 'POST', {})).status).toBe(500);
  expect((await ok<{ nodes: NoteNode[] }>('/api/nodes')).nodes.map((n) => n.id)).toEqual([note.id]);
  expect(
    (await bindings.DB.prepare('SELECT COUNT(*) count FROM backup_restore_nodes').first<{
      count: number;
    }>())!.count,
  ).toBe(0);
});

it('restores empty bodies and recovers from truncated uploads without leaking reserved space', async () => {
  await create({ kind: 'text', title: '空白正文', content: '' });
  const pdf = await file('test.pdf', '%PDF-1.4\n%%EOF');
  await create({ kind: 'pdf', title: 'PDF', fileId: pdf.id });
  const formatted =
    '{\n  "number": 1.00,\n  "name": "\\u4e66",\n  "file": "/api/files/' + pdf.id + '"\n}\n';
  await create({ kind: 'text', title: 'JSON 排版', content: formatted });
  const { archive } = await ok<{ archive: LibraryBackup }>('/api/backups', 'POST', {});
  const stage = await ok<{ id: string }>('/api/backups/restore', 'POST', archive);
  const allocated = async () =>
    (await bindings.DB.prepare('SELECT allocated_bytes FROM site WHERE id=1').first<{
      allocated_bytes: number;
    }>())!.allocated_bytes;
  const before = await allocated();
  const response = await SELF.fetch(`https://notes.test/api/backups/${stage.id}/files/${pdf.id}`, {
    method: 'POST',
    headers: { cookie, origin: 'https://notes.test' },
    body: '%PDF',
  });
  expect(response.status).toBe(400);
  expect(await allocated()).toBe(before);
  expect(
    (await bindings.DB.prepare("SELECT count(*) count FROM blobs WHERE state='pending'").first<{
      count: number;
    }>())!.count,
  ).toBe(0);
  await uploadArchive(stage.id, archive);
  const { rootId } = await ok<{ rootId: string }>(`/api/backups/${stage.id}/commit`, 'POST', {});
  const nodes = (await ok<{ nodes: NoteNode[] }>(`/api/nodes?parent=${rootId}`)).nodes;
  expect(
    (await ok<NoteDetail>(`/api/nodes/${nodes.find((n) => n.title === '空白正文')!.id}`)).content,
  ).toBe('');
  expect(
    (await ok<NoteDetail>(`/api/nodes/${nodes.find((n) => n.title === 'JSON 排版')!.id}`)).content,
  ).toBe(formatted.replace(pdf.id, nodes.find((n) => n.kind === 'pdf')!.file_blob_id!));
});

it('restores a large directory within the free-plan query budget and per-value byte limit', async () => {
  const { archive } = await ok<{ archive: LibraryBackup }>('/api/backups', 'POST', {});
  archive.tables.nodes = Array.from({ length: 4000 }, (_, i) => ({
    id: `folder_${i}`,
    parent_id: null,
    kind: 'folder',
    title: `${'目录📖'.repeat(35)} ${i}`,
    position: i,
    url: null,
    arxiv_id: null,
    file_blob_id: null,
    current_version_id: null,
    revision: 1,
    trash_id: null,
    created_at: 1,
    updated_at: 1,
  }));
  let queries = 0;
  const counted = {
    ...bindings,
    DB: new Proxy(bindings.DB, {
      get(target, key) {
        if (key === 'prepare')
          return (sql: string) => {
            queries++;
            return target.prepare(sql);
          };
        const value = target[key as keyof D1Database];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  };
  const stage = await startRestore(counted, archive, crypto.randomUUID());
  expect(queries).toBeLessThanOrEqual(40);
  queries = 0;
  const { rootId } = await finishRestore(counted, stage.id);
  expect(queries).toBeLessThanOrEqual(40);
  expect(
    (await bindings.DB.prepare('SELECT count(*) count FROM nodes WHERE parent_id=?')
      .bind(rootId)
      .first<{ count: number }>())!.count,
  ).toBe(4000);
}, 30000);

it('restores global conversation into its own note without overwriting the current global history', async () => {
  const body = await storeChatBody(bindings, JSON.stringify({ content: '全局记录' }));
  await bindings.DB.prepare('INSERT INTO assistant_threads(node_id) VALUES(?)')
    .bind(GLOBAL_ASSISTANT_ID)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO assistant_messages(id,node_id,request_id,role,status,body_blob_id,created_at) VALUES(?,?,?,'assistant','completed',?,1)",
  )
    .bind(crypto.randomUUID(), GLOBAL_ASSISTANT_ID, 'global-request', body.id)
    .run();
  const snapshot = await ok<{ archive: LibraryBackup }>('/api/backups', 'POST', {});
  const stage = await ok<{ id: string }>('/api/backups/restore', 'POST', snapshot.archive, {
    'x-idempotency-key': crypto.randomUUID(),
  });
  await uploadArchive(stage.id, snapshot.archive);
  const { rootId } = await ok<{ rootId: string }>(`/api/backups/${stage.id}/commit`, 'POST', {});
  const restored = (await ok<{ nodes: NoteNode[] }>(`/api/nodes?parent=${rootId}`)).nodes.find(
    (n) => n.title === '青藜全局对话（恢复）',
  )!;
  expect(restored.kind).toBe('text');
  expect((await ok<ChatHistory>(`/api/nodes/${restored.id}/assistant`)).messages[0].content).toBe(
    '全局记录',
  );
  expect(
    (await ok<ChatHistory>(`/api/nodes/${GLOBAL_ASSISTANT_ID}/assistant`)).messages,
  ).toHaveLength(1);
});
