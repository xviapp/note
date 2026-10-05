/// <reference types="@cloudflare/vitest-pool-workers/types" />
import {
  env,
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker/index';
import type { Env } from '../worker/types';
import type { NoteNode, SearchResult, StorageInfo } from '../shared/types';
import type { ChatHistory } from '../shared/assistant';
import type { AnnotationList } from '../shared/annotations';
import { cleanup } from '../worker/recovery';

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
const location = (exact: string, start = 0) => ({
  kind: 'text',
  start,
  end: start + exact.length,
  exact,
  prefix: '',
  suffix: '',
});
const path = (node: NoteNode) => `/api/nodes/${node.id}/annotations`;
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
  vi.restoreAllMocks();
});

describe('annotations', () => {
  it('adds, edits and deletes highlights without an edit token', async () => {
    const node = await ok<NoteNode>('/api/nodes', 'POST', {
      kind: 'markdown',
      title: '读书笔记',
      content: 'First sentence. Second sentence.',
    });
    expect(await ok<AnnotationList>(path(node))).toEqual({ annotations: [], updatedAt: null });
    await ok(`${path(node)}/a1`, 'PUT', {
      quote: 'First sentence.',
      note: '',
      location: location('First sentence.'),
    });
    const second = await ok<AnnotationList>(`${path(node)}/a2`, 'PUT', {
      quote: 'Second sentence.',
      note: '要点',
      location: location('Second sentence.', 16),
    });
    expect(second.annotations.map((item) => [item.id, item.note])).toEqual([
      ['a1', ''],
      ['a2', '要点'],
    ]);
    // Editing keeps the creation time; repeating a request changes nothing else.
    const created = second.annotations[0].createdAt;
    const edited = await ok<AnnotationList>(`${path(node)}/a1`, 'PUT', {
      quote: 'First sentence.',
      note: '  补充  ',
      location: location('First sentence.'),
    });
    expect(edited.annotations[0]).toMatchObject({ id: 'a1', note: '补充', createdAt: created });
    expect(edited.annotations).toHaveLength(2);
    await ok(`${path(node)}/a2`, 'DELETE');
    const left = await ok<AnnotationList>(`${path(node)}/a2`, 'DELETE');
    expect(left.annotations.map((item) => item.id)).toEqual(['a1']);
    // One document stays referenced after several saves.
    await cleanup(bindings);
    expect(
      (await bindings.DB.prepare(
        "SELECT COUNT(*) AS n FROM blobs WHERE name='content.txt' AND id NOT IN (SELECT body_blob_id FROM versions)",
      ).first<{ n: number }>())!.n,
    ).toBe(1);
  });

  it('rejects invalid input and folders', async () => {
    const node = await ok<NoteNode>('/api/nodes', 'POST', { kind: 'text', title: 'T' });
    const folder = await ok<NoteNode>('/api/nodes', 'POST', { kind: 'folder', title: 'F' });
    const valid = { quote: 'x', note: '', location: location('x') };
    expect((await request(`${path(node)}/a1`, 'PUT', { ...valid, quote: ' ' })).status).toBe(400);
    expect((await request(`${path(node)}/a1`, 'PUT', { ...valid, location: null })).status).toBe(
      400,
    );
    expect(
      (await request(`${path(node)}/a1`, 'PUT', { ...valid, note: 'x'.repeat(5001) })).status,
    ).toBe(400);
    expect((await request(`${path(folder)}/a1`, 'PUT', valid)).status).toBe(400);
  });

  it('goes with its file: trash keeps it, purge and cleanup free it', async () => {
    const node = await ok<NoteNode>('/api/nodes', 'POST', { kind: 'text', title: 'T' });
    await ok(`${path(node)}/a1`, 'PUT', { quote: 'x', note: 'n', location: location('x') });
    const preview = await ok<{ count: number }>(`/api/nodes/${node.id}/delete-preview`);
    const trash = await ok<{ id: string }>(`/api/nodes/${node.id}`, 'DELETE', {
      count: preview.count,
    });
    await cleanup(bindings);
    expect(await bindings.DB.prepare('SELECT COUNT(*) AS n FROM annotations').first('n')).toBe(1);
    await ok(`/api/trash/${trash.id}`, 'DELETE');
    await Promise.all(contexts.map(waitOnExecutionContext));
    await cleanup(bindings);
    expect(await bindings.DB.prepare('SELECT COUNT(*) AS n FROM annotations').first('n')).toBe(0);
    expect((await ok<StorageInfo>('/api/storage')).allocatedBytes).toBe(0);
  });

  it('keeps a colour, defaulting to yellow, and rejects unknown ones', async () => {
    const node = await ok<NoteNode>('/api/nodes', 'POST', { kind: 'text', title: 'T' });
    const plain = { quote: 'x', note: '', location: location('x') };
    const list = await ok<AnnotationList>(`${path(node)}/a1`, 'PUT', plain);
    expect(list.annotations[0].color).toBe('yellow');
    await ok(`${path(node)}/a2`, 'PUT', { ...plain, color: 'blue' });
    expect((await ok<AnnotationList>(path(node))).annotations[1].color).toBe('blue');
    expect((await request(`${path(node)}/a3`, 'PUT', { ...plain, color: 'red' })).status).toBe(400);
  });

  it('finds files by their highlights and notes', async () => {
    const node = await ok<NoteNode>('/api/nodes', 'POST', { kind: 'text', title: '读书' });
    await ok(`${path(node)}/a1`, 'PUT', {
      quote: 'Attention is all you need',
      note: '核心论点',
      location: location('Attention is all you need'),
    });
    await ok(`${path(node)}/a2`, 'PUT', {
      quote: 'Other words',
      note: '',
      location: location('Other words', 40),
    });
    const { results } = await ok<{ results: SearchResult[] }>(
      `/api/search?q=${encodeURIComponent('attention 核心')}`,
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: node.id,
      annotation: { id: 'a1', quote: 'Attention is all you need', note: '核心论点' },
    });
    // Words split across two annotations do not match one.
    expect(
      (await ok<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent('other 核心')}`))
        .results,
    ).toHaveLength(0);
    // A deleted annotation is no longer found.
    await ok(`${path(node)}/a1`, 'DELETE');
    expect((await ok<{ results: SearchResult[] }>('/api/search?q=attention')).results).toEqual([]);
  });

  it('sends the notes to Qingli with a question and keeps them on the message', async () => {
    await ok('/api/ai/settings', 'PUT', { apiKey: 'sk-test-only-fake-deepseek-key' });
    const node = await ok<NoteNode>('/api/nodes', 'POST', { kind: 'text', title: 'T' });
    const ask = (data: object) => request(`/api/nodes/${node.id}/assistant`, 'POST', data);
    expect((await ask({ content: '总结', annotations: true })).status).toBe(400);
    await ok(`${path(node)}/a1`, 'PUT', {
      quote: '重要的一句',
      note: '需要复习',
      location: location('重要的一句'),
    });
    const sent: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      sent.push(JSON.stringify(JSON.parse(String(init!.body)).messages));
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: '好的' } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const response = await ask({ content: '总结', annotations: true });
    expect(response.status).toBe(200);
    await response.text();
    expect(sent[0]).toContain('<我的批注>');
    expect(sent[0]).toContain('原文：重要的一句');
    expect(sent[0]).toContain('我的批注：需要复习');
    const history = await ok<ChatHistory>(`/api/nodes/${node.id}/assistant`);
    expect(history.messages[0].annotations).toContain('需要复习');
  });
});
