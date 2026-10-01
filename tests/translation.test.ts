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
import type {
  Translation,
  TranslationEvent,
  TranslationHistory,
  SourceLocation,
} from '../shared/translation';
import type { FileInfo, NoteDetail, NoteNode, StorageInfo } from '../shared/types';
import { sseData } from '../shared/sse';
import { cleanup } from '../worker/recovery';
import { discardFile } from '../worker/storage';

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const key = 'sk-test-only-fake-deepseek-key';
let cookie = '';
let contexts: ExecutionContext[] = [];
beforeAll(() => applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS));
async function request(
  path: string,
  method = 'GET',
  data?: unknown,
  options: {
    anonymous?: boolean;
    key?: string;
    origin?: string;
    signal?: AbortSignal;
  } = {},
) {
  const context = createExecutionContext();
  contexts.push(context);
  return worker.fetch(
    new Request(`https://notes.test${path}`, {
      method,
      signal: options.signal,
      headers: {
        origin: options.origin || 'https://notes.test',
        'content-type': 'application/json',
        ...(!options.anonymous ? { cookie } : {}),
        ...(options.key ? { 'x-idempotency-key': options.key } : {}),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    }),
    bindings,
    context,
  );
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
async function create(title = '资料 A', extra = {}) {
  return ok<NoteNode>('/api/nodes', 'POST', {
    kind: 'markdown',
    title,
    content: '未经引用的私密全文，不得上传。',
    ...extra,
  });
}
async function configure() {
  await ok('/api/ai/settings', 'PUT', { apiKey: key });
}
function provider(content = '# 阅读结论\n\n解释所选文字。', complete: boolean | 'length' = true) {
  const data = `: keepalive\r\n\r\ndata: ${JSON.stringify({ choices: [{ delta: { content } }] })}\r\n\r\n${complete ? `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: complete === 'length' ? 'length' : 'stop' }] })}\n\ndata: [DONE]\n\n` : ''}`;
  const bytes = new TextEncoder().encode(data);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        // Deliberately split both SSE lines and Chinese UTF-8 characters.
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
async function events(response: Response): Promise<TranslationEvent[]> {
  expect(response.status).toBe(200);
  const result: TranslationEvent[] = [];
  for await (const line of sseData(response.body!)) result.push(JSON.parse(line));
  return result;
}
const path = (node: NoteNode) => `/api/nodes/${node.id}/translations`;
const selected = 'The selected passage with $E=mc^2$.';
const anchor: SourceLocation = {
  kind: 'text',
  start: 5,
  end: 5 + selected.length,
  exact: selected,
  prefix: 'Intro',
  suffix: ' After',
};
const input = { source: selected, targetLanguage: 'zh-CN', location: anchor };
async function translate(node: NoteNode, extra = {}, options = {}) {
  const response = await request(path(node), 'POST', { ...input, ...extra }, options);
  return response.headers.get('content-type')?.includes('application/json')
    ? [(await response.json()) as TranslationEvent]
    : events(response);
}
function completed(events: TranslationEvent[]): Translation {
  const event = events.at(-1);
  expect(event?.type).toBe('done');
  return (event as Extract<TranslationEvent, { type: 'done' }>).translation;
}
async function history(node: NoteNode) {
  return ok<TranslationHistory>(path(node));
}
async function uploadAttachment(
  node: NoteNode,
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
  anonymous = false,
) {
  const context = createExecutionContext();
  contexts.push(context);
  return worker.fetch(
    new Request(
      `https://notes.test/api/nodes/${node.id}/assistant/files?name=${encodeURIComponent(name)}&size=${bytes.length}`,
      {
        method: 'POST',
        headers: { origin: 'https://notes.test', ...(!anonymous ? { cookie } : {}) },
        body: bytes,
      },
    ),
    bindings,
    context,
  );
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
});
afterEach(async () => {
  await Promise.all(contexts.map(waitOnExecutionContext));
  vi.restoreAllMocks();
});

describe('saved per-file translations', () => {
  it('requires authentication and same origin, validates input, and works without an edit token', async () => {
    const node = await create();
    expect((await request(path(node), 'GET', undefined, { anonymous: true })).status).toBe(401);
    expect((await request(path(node), 'POST', input, { origin: 'https://evil.test' })).status).toBe(
      403,
    );
    for (const invalid of [
      { source: '' },
      { source: 'a'.repeat(10001) },
      { targetLanguage: 'xx' },
      { refresh: 'yes' },
      { location: { ...anchor, end: 1 } },
      { location: { kind: 'pdf', fileId: 'unknown', page: 1, endPage: 1, rects: [] } },
    ]) {
      expect((await request(path(node), 'POST', { ...input, ...invalid })).status).toBe(400);
    }
    const folder = await create('文件夹', { kind: 'folder', content: undefined });
    expect((await request(path(folder))).status).toBe(400);
    expect((await request(`${path(node)}?offset=-1`)).status).toBe(400);
    await configure();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(provider('被选中的段落。'));
    expect(completed(await translate(node)).content).toBe('被选中的段落。');
  });

  it('streams only selected text, saves anchors, and reuses a durable cache with no key or free space', async () => {
    const node = await create();
    await configure();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const payload = JSON.parse(init!.body as string);
      expect(payload.messages).toHaveLength(2);
      expect(payload.messages[1]).toEqual({ role: 'user', content: selected });
      expect(JSON.stringify(payload)).not.toContain('未经引用的私密全文');
      expect(JSON.stringify(payload)).not.toContain('Intro');
      expect(payload.thinking).toEqual({ type: 'disabled' });
      expect(payload.max_tokens).toBe(8192);
      return provider('所选段落含 $E=mc^2$。');
    });
    const saved = completed(await translate(node));
    expect(saved.location).toEqual(anchor);
    expect((await history(node)).translations).toEqual([
      {
        id: saved.id,
        excerpt: selected,
        targetLanguage: 'zh-CN',
        savedAt: saved.savedAt,
        locationLabel: '正文',
      },
    ]);
    expect(await ok(`${path(node)}/${saved.id}`)).toEqual(saved);
    await ok('/api/ai/settings', 'DELETE');
    await bindings.DB.prepare('UPDATE site SET quota_bytes=allocated_bytes WHERE id=1').run();
    // New request/context (as after a reload or from another device), without model access.
    const cached = await translate(node, { location: null });
    expect(cached).toEqual([{ type: 'done', translation: saved, cached: true }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const other = await create('其他文件', { kind: 'folder', content: undefined });
    expect((await request(`${path(other)}/${saved.id}`)).status).toBe(400);
  });

  it('separates languages and files, paginates history, and keeps the first occurrence for cache hits', async () => {
    const node = await create(),
      other = await create('另一个文件');
    await configure();
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => provider('译文'));
    const first = completed(await translate(node));
    const english = completed(await translate(node, { targetLanguage: 'en' }));
    const another = completed(await translate(other));
    expect(new Set([first.id, english.id, another.id]).size).toBe(3);
    expect((await request(`${path(other)}/${first.id}`)).status).toBe(404);
    expect(
      completed(
        await translate(node, { location: { ...anchor, start: 10, end: 10 + selected.length } }),
      ).location,
    ).toEqual(anchor);
    for (let i = 0; i < 20; i++) await translate(node, { source: `Passage ${i}`, location: null });
    const list = await history(node);
    expect(list.translations).toHaveLength(20);
    expect(list.nextOffset).toBe(20);
    const last = await ok<TranslationHistory>(`${path(node)}?offset=20`);
    expect(last.translations).toHaveLength(2);
    expect(last.nextOffset).toBeNull();
    expect(mock).toHaveBeenCalledTimes(23);
  });

  it('saves PDF page rectangles for main files and attachments, rejecting unrelated files', async () => {
    const owner = await create();
    const pdf = (await (
      await uploadAttachment(owner, 'paper.pdf', new TextEncoder().encode('%PDF-1.4\n%%EOF'))
    ).json()) as FileInfo;
    const node = await create('PDF', { kind: 'pdf', content: undefined, fileId: pdf.id });
    const attachment = await create('附件', { attachments: [pdf.id] });
    const location: SourceLocation = {
      kind: 'pdf',
      fileId: pdf.id,
      page: 3,
      endPage: 4,
      rects: [
        { page: 3, x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
        { page: 4, x: 0.1, y: 0.1, width: 0.4, height: 0.04 },
      ],
    };
    await configure();
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => provider('PDF 译文'));
    for (const item of [node, attachment]) {
      const saved = completed(await translate(item, { location }));
      expect(saved.location).toEqual({ ...location, fileName: 'paper.pdf' });
      expect((await history(item)).translations[0].locationLabel).toBe('PDF · 第 3–4 页');
      expect((await ok<Translation>(`${path(item)}/${saved.id}`)).location).toEqual(saved.location);
    }
    expect((await request(path(owner), 'POST', { ...input, location })).status).toBe(400);
    expect(
      (
        await request(path(owner), 'POST', {
          ...input,
          location: { ...location, rects: [{ page: 3, x: 0.9, y: 0, width: 0.9, height: 1 }] },
        })
      ).status,
    ).toBe(400);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('keeps a completed translation when regeneration is interrupted, too long, or out of quota', async () => {
    const node = await create();
    await configure();
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(provider('完整旧译文'));
    const saved = completed(await translate(node));
    for (const finish of [false, 'length'] as const) {
      mock.mockResolvedValueOnce(provider('不完整的新译文', finish));
      const result = await translate(node, { refresh: true });
      expect(result.at(-1)?.type).toBe('error');
      expect(await ok(`${path(node)}/${saved.id}`)).toEqual(saved);
    }
    await bindings.DB.prepare('UPDATE site SET quota_bytes=allocated_bytes+1000 WHERE id=1').run();
    mock.mockResolvedValueOnce(provider('字'.repeat(2000)));
    expect((await translate(node, { refresh: true })).at(-1)?.type).toBe('error');
    expect(await ok(`${path(node)}/${saved.id}`)).toEqual(saved);
    expect((await ok<StorageInfo>('/api/storage')).orphanBytes).toBe(0);
    await bindings.DB.prepare('UPDATE site SET quota_bytes=allocated_bytes WHERE id=1').run();
    expect((await request(path(node), 'POST', { ...input, refresh: true })).status).toBe(413);
    expect(mock).toHaveBeenCalledTimes(4);
    await bindings.DB.prepare('UPDATE site SET quota_bytes=8000000000 WHERE id=1').run();
    mock.mockResolvedValueOnce(provider('完整新译文'));
    const next = completed(await translate(node, { refresh: true }, { key: 'retry-success-key' }));
    expect(next.id).toBe(saved.id);
    expect(next.content).toBe('完整新译文');
    expect(
      completed(await translate(node, { refresh: true }, { key: 'retry-success-key' })),
    ).toEqual(next);
    expect(mock).toHaveBeenCalledTimes(5);
  });

  it('locks concurrent calls and lets an explicitly retried request recover after failure', async () => {
    const node = await create();
    await configure();
    let release!: (response: Response) => void;
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = await request(path(node), 'POST', input, { key: 'same-request-key' });
    await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(1));
    expect((await request(path(node), 'POST', input)).status).toBe(409);
    expect((await request(path(node), 'POST', input, { key: 'same-request-key' })).status).toBe(
      409,
    );
    release(provider('失败片段', false));
    expect((await events(pending)).at(-1)?.type).toBe('error');
    expect((await history(node)).translations).toHaveLength(0);
    expect((await request(path(node), 'POST', input, { key: 'same-request-key' })).status).toBe(
      409,
    );
    mock.mockResolvedValueOnce(provider('重试成功'));
    expect(completed(await translate(node)).content).toBe('重试成功');
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('aborts the provider when the caller cancels and never persists a partial result', async () => {
    const node = await create();
    await configure();
    let signal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      signal = init?.signal as AbortSignal;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"choices":[{"delta":{"content":"片段"}}]}\n\n'),
            );
            signal!.addEventListener('abort', () =>
              controller.error(new DOMException('Aborted', 'AbortError')),
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const abort = new AbortController();
    const response = await request(path(node), 'POST', input, { signal: abort.signal });
    const reader = response.body!.getReader();
    await reader.read();
    abort.abort();
    while (!(await reader.read()).done) {
      /* Drain cancellation and release the lock. */
    }
    expect(signal?.aborted).toBe(true);
    expect((await history(node)).translations).toHaveLength(0);
  });

  it('accounts for saved translations in storage and retains them through cleanup and trash restore', async () => {
    const node = await create();
    await configure();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => provider('需要保留的译文'));
    const saved = completed(await translate(node));
    const row = await bindings.DB.prepare('SELECT body_blob_id FROM translations WHERE id=?')
      .bind(saved.id)
      .first<{ body_blob_id: string }>();
    await discardFile(bindings, row!.body_blob_id);
    await cleanup(bindings);
    expect(await ok(`${path(node)}/${saved.id}`)).toEqual(saved);
    const space = await ok<StorageInfo>('/api/storage');
    expect(space.orphanBytes).toBe(0);
    expect(space.currentBytes).toBe(space.allocatedBytes);
    const trash = await ok<{ id: string }>(`/api/nodes/${node.id}`, 'DELETE', { count: 1 });
    expect((await request(path(node))).status).toBe(410);
    expect((await ok<StorageInfo>('/api/storage')).trashBytes).toBe(space.currentBytes);
    await ok(`/api/trash/${trash.id}/restore`, 'POST', {});
    expect(await ok(`${path(node)}/${saved.id}`)).toEqual(saved);
    await ok(`${path(node)}/${saved.id}`, 'DELETE');
    expect((await history(node)).translations).toHaveLength(0);
    expect((await ok<StorageInfo>('/api/storage')).allocatedBytes).toBeLessThan(
      space.allocatedBytes,
    );
    const again = completed(await translate(node));
    const trashed = await ok<{ id: string }>(`/api/nodes/${node.id}`, 'DELETE', { count: 1 });
    await ok(`/api/trash/${trashed.id}`, 'DELETE');
    await Promise.all(contexts.map(waitOnExecutionContext));
    await cleanup(bindings);
    expect(
      await bindings.DB.prepare('SELECT id FROM translations WHERE id=?').bind(again.id).first(),
    ).toBeNull();
    expect((await ok<StorageInfo>('/api/storage')).allocatedBytes).toBe(0);
  });
});
