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
import { fillTemplate } from '../shared/journals';

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
    expect(detail.journal_entry).toEqual({ date: '2026-09-07', journal_id: book.id });
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
    // Both days share the year and month folders.
    const years = await ok<{ nodes: NoteNode[] }>(`/api/nodes?parent=${book.id}`);
    expect(years.nodes.map((node) => node.title).sort()).toEqual(['2026年', 'templates']);
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
  it('lists templates and fills them in', async () => {
    const book = await journal();
    const folders = await ok<{ nodes: NoteNode[] }>(`/api/nodes?parent=${book.id}`);
    const templates = folders.nodes.find((node) => node.title === 'templates')!;
    await ok('/api/nodes', 'POST', {
      kind: 'markdown',
      parentId: templates.id,
      title: '每日.md',
      content: '# {{日期}} {{星期}}\n\n## 今天做了什么',
    });
    const month = await ok<JournalMonth>(`/api/nodes/${book.id}/journal?month=2026-09`);
    expect(month.templates.map((item) => item.title)).toEqual(['每日.md']);
    expect(fillTemplate('# {{日期}} {{星期}} {{unknown}}', '2026-10-07')).toBe(
      '# 2026年10月7日 星期三 {{unknown}}',
    );
  });
});
