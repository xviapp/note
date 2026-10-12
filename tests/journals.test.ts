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
import type { NoteDetail, NoteNode } from '../shared/types';
import type { JournalMonth } from '../shared/journals';

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
beforeEach(async () => {
  contexts = [];
  cookie = '';
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
  const setup = await request('/api/auth/setup', 'POST', {
    token: bindings.SETUP_TOKEN,
    password: 'Note2026',
  });
  cookie = setup.headers.get('set-cookie')!.split(';')[0];
});
afterEach(async () => {
  await Promise.all(contexts.map(waitOnExecutionContext));
});

const journal = () =>
  ok<NoteNode>('/api/nodes', 'POST', { kind: 'folder', title: '日记', journal: true });
const write = (id: string, date: string, content = '今天') =>
  ok<{ node: NoteNode; created: boolean }>(`/api/nodes/${id}/journal/entries`, 'POST', {
    date,
    content,
  });

describe('journals', () => {
  it('writes one entry per day, filed by year and month', async () => {
    const book = await journal();
    expect(book.variant).toBe('journal');
    const first = await write(book.id, '2026-09-07', '# 第一天');
    expect(first.created).toBe(true);
    expect(first.node.title).toBe('2026-09-07');
    const detail = await ok<NoteDetail>(`/api/nodes/${first.node.id}`);
    expect(detail.journal_entry).toEqual({
      date: '2026-09-07',
      journal_id: book.id,
      previous: null,
      next: null,
    });
    expect(detail.breadcrumbs.map((part) => part.title)).toEqual([
      '日记',
      '2026年',
      '9月',
      '2026-09-07',
    ]);
    // The same day opens the entry already written.
    const again = await write(book.id, '2026-09-07', '别的内容');
    expect(again).toMatchObject({ created: false, node: { id: first.node.id } });
    await write(book.id, '2026-09-08');
    const month = await ok<JournalMonth>(`/api/nodes/${book.id}/journal?month=2026-09`);
    expect(month.entries.map((entry) => entry.date)).toEqual(['2026-09-07', '2026-09-08']);
    expect(month.recent[0].date).toBe('2026-09-08');
    // An entry links to the nearest days written around it, skipping trashed ones.
    const earlier = await write(book.id, '2026-08-30');
    const trashed = await write(book.id, '2026-09-01');
    await ok(`/api/nodes/${trashed.node.id}`, 'DELETE', { count: 1 });
    const linked = (await ok<NoteDetail>(`/api/nodes/${first.node.id}`)).journal_entry!;
    expect(linked.previous).toEqual({ id: earlier.node.id, date: '2026-08-30' });
    expect(linked.next).toMatchObject({ date: '2026-09-08' });
    // Both days share the year and month folders.
    const years = await ok<{ nodes: NoteNode[] }>(`/api/nodes?parent=${book.id}`);
    expect(years.nodes.map((node) => node.title)).toEqual(['2026年']);
  });
  it('lists journals by their latest entry', async () => {
    const older = await journal();
    const newer = await journal();
    const empty = await journal();
    await write(older.id, '2026-09-01');
    await write(newer.id, '2026-09-05');
    const listed = await ok<{ nodes: NoteNode[] }>('/api/nodes?view=journals');
    expect(listed.nodes.map((node) => node.id)).toEqual([newer.id, older.id, empty.id]);
    // A trashed journal is left out.
    const { count } = await ok<{ count: number }>(`/api/nodes/${newer.id}/delete-preview`);
    await ok(`/api/nodes/${newer.id}`, 'DELETE', { count });
    const remaining = await ok<{ nodes: NoteNode[] }>('/api/nodes?view=journals');
    expect(remaining.nodes.map((node) => node.id)).toEqual([older.id, empty.id]);
  });
  it('puts the 今日记 journal chosen in settings first', async () => {
    const chosen = await journal();
    const latest = await journal();
    await write(latest.id, '2026-09-05');
    expect(await ok('/api/journals/quick')).toEqual({ journalId: null });
    expect(await ok('/api/journals/quick', 'PUT', { journalId: chosen.id })).toEqual({ journalId: chosen.id });
    const listed = await ok<{ nodes: NoteNode[] }>('/api/nodes?view=journals');
    expect(listed.nodes.map((node) => node.id)).toEqual([chosen.id, latest.id]);
    // Only a live journal can be chosen.
    const folder = await ok<NoteNode>('/api/nodes', 'POST', { kind: 'folder', title: '文件夹' });
    expect((await request('/api/journals/quick', 'PUT', { journalId: folder.id })).status).toBe(409);
    // Trashing the chosen journal falls back to the latest one.
    const { count } = await ok<{ count: number }>(`/api/nodes/${chosen.id}/delete-preview`);
    await ok(`/api/nodes/${chosen.id}`, 'DELETE', { count });
    expect(await ok('/api/journals/quick')).toEqual({ journalId: null });
  });
  it('refuses future days and frees a day whose entry was trashed', async () => {
    const book = await journal();
    const future = await request(`/api/nodes/${book.id}/journal/entries`, 'POST', {
      date: '2999-01-01',
      content: '',
    });
    expect(future.status).toBe(400);
    expect(
      (await request(`/api/nodes/${book.id}/journal/entries`, 'POST', { date: '2026-02-30' }))
        .status,
    ).toBe(400);
    const first = await write(book.id, '2026-03-01');
    await ok(`/api/nodes/${first.node.id}`, 'DELETE', { count: 1 });
    const second = await write(book.id, '2026-03-01');
    expect(second.created).toBe(true);
    expect(second.node.id).not.toBe(first.node.id);
  });
});
