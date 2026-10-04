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
import type { NoteNode, StorageInfo } from '../shared/types';
import type { PaperTranslation } from '../shared/paper-translation';
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
async function paper(title = 'Attention Paper') {
  const node = await ok<NoteNode>('/api/nodes', 'POST', {
    kind: 'link',
    title,
    url: 'https://arxiv.org/html/2503.01800v1',
  });
  await bindings.DB.prepare("UPDATE nodes SET arxiv_id='2503.01800v1' WHERE id=?")
    .bind(node.id)
    .run();
  return node;
}
async function hash(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
const block = async (text: string) => ({ hash: await hash(text), text });
// The provider streams one JSON object; `reply` maps the segments it was sent.
function provider(reply: (segments: string[]) => unknown) {
  const sent: string[][] = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init!.body));
    expect(body.response_format).toEqual({ type: 'json_object' });
    const segments = JSON.parse(body.messages.at(-1).content).segments as string[];
    sent.push(segments);
    const content = JSON.stringify(reply(segments));
    const data = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
    return new Response(data, { headers: { 'content-type': 'text/event-stream' } });
  });
  return { fetch, sent };
}
const zh = (segments: string[]) => ({
  translations: segments.map((text) => `译：${text}`),
});
const path = (node: NoteNode) => `/api/nodes/${node.id}/paper-translation`;
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
    bindings.DB.prepare('DELETE FROM ai_settings'),
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
  await ok('/api/ai/settings', 'PUT', { apiKey: 'sk-test-only-fake-deepseek-key' });
});
afterEach(async () => {
  await Promise.all(contexts.map(waitOnExecutionContext));
  vi.restoreAllMocks();
});

describe('whole-paper translation', () => {
  it('translates batches once, merges them and reads them back per language', async () => {
    const node = await paper();
    const { sent } = provider(zh);
    const first = [await block('Attention is all you need.'), await block('We use ⟦1⟧ layers.')];
    const saved = await ok<PaperTranslation>(path(node), 'POST', {
      language: 'zh-CN',
      blocks: first,
    });
    expect(saved.blocks[first[1].hash]).toBe('译：We use ⟦1⟧ layers.');
    // Already translated paragraphs are not paid for again.
    const second = [first[0], await block('Results improve.')];
    const merged = await ok<PaperTranslation>(path(node), 'POST', {
      language: 'zh-CN',
      blocks: second,
    });
    expect(sent).toEqual([[first[0].text, first[1].text], ['Results improve.']]);
    expect(Object.keys(merged.blocks)).toHaveLength(2);
    const all = await ok<PaperTranslation>(`${path(node)}?language=zh-CN`);
    expect(Object.keys(all.blocks)).toHaveLength(3);
    expect(all.updatedAt).toBeGreaterThan(0);
    expect((await ok<PaperTranslation>(`${path(node)}?language=ja`)).blocks).toEqual({});
    // Refresh pays for exactly the paragraph asked for.
    await ok(path(node), 'POST', { language: 'zh-CN', blocks: [first[0]], refresh: true });
    expect(sent.at(-1)).toEqual([first[0].text]);
    // Only one translation document stays referenced after several merges.
    await cleanup(bindings);
    const documents = await bindings.DB.prepare(
      "SELECT COUNT(*) AS n FROM blobs WHERE name='content.txt'",
    ).first<{ n: number }>();
    expect(documents!.n).toBe(1);
  });

  it('keeps every placeholder and rejects replies that do not line up', async () => {
    const node = await paper();
    const source = await block('See ⟦1⟧ and ⟦2⟧ for ⟦3⟧.');
    provider(() => ({ translations: ['参见⟦2⟧。'] }));
    const saved = await ok<PaperTranslation>(path(node), 'POST', {
      language: 'zh-CN',
      blocks: [source],
    });
    expect(saved.blocks[source.hash]).toBe('参见⟦2⟧。 ⟦1⟧ ⟦3⟧');
    vi.restoreAllMocks();
    provider(() => ({ translations: ['只有一段'] }));
    const two = [await block('One.'), await block('Two.')];
    const response = await request(path(node), 'POST', { language: 'zh-CN', blocks: two });
    expect(response.status).toBe(502);
    const all = await ok<PaperTranslation>(`${path(node)}?language=zh-CN`);
    expect(Object.keys(all.blocks)).toEqual([source.hash]);
  });

  it('validates papers, languages, hashes and batch size before calling the model', async () => {
    const { fetch } = provider(zh);
    const node = await paper();
    const note = await ok<NoteNode>('/api/nodes', 'POST', { kind: 'markdown', title: '笔记' });
    const good = [await block('Text.')];
    const status = async (target: NoteNode, data: unknown) =>
      (await request(path(target), 'POST', data)).status;
    expect(await status(note, { language: 'zh-CN', blocks: good })).toBe(400);
    expect(await status(node, { language: 'xx', blocks: good })).toBe(400);
    expect(await status(node, { language: 'zh-CN', blocks: [{ hash: 'abc', text: 'x' }] })).toBe(
      400,
    );
    expect(await status(node, { language: 'zh-CN', blocks: [] })).toBe(400);
    const long = await Promise.all(
      Array.from({ length: 3 }, (_, i) => block(`${i} ${'word '.repeat(400)}`)),
    );
    expect(await status(node, { language: 'zh-CN', blocks: long })).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect((await request(`${path(node)}?language=zh-CN`, 'GET')).status).toBe(200);
  });

  it('goes with its paper: trash keeps it, purge and cleanup free it', async () => {
    const node = await paper();
    provider(zh);
    await ok(path(node), 'POST', { language: 'zh-CN', blocks: [await block('Kept text.')] });
    const preview = await ok<{ count: number }>(`/api/nodes/${node.id}/delete-preview`);
    const trash = await ok<{ id: string }>(`/api/nodes/${node.id}`, 'DELETE', {
      count: preview.count,
    });
    await cleanup(bindings);
    expect(
      await bindings.DB.prepare('SELECT COUNT(*) AS n FROM paper_translations').first('n'),
    ).toBe(1);
    await ok(`/api/trash/${trash.id}`, 'DELETE');
    await Promise.all(contexts.map(waitOnExecutionContext));
    await cleanup(bindings);
    expect(
      await bindings.DB.prepare('SELECT COUNT(*) AS n FROM paper_translations').first('n'),
    ).toBe(0);
    expect((await ok<StorageInfo>('/api/storage')).allocatedBytes).toBe(0);
  });
});
