import { AI_RESPONSE_CHARACTER_LIMIT, GLOBAL_ASSISTANT_ID } from '../shared/assistant';
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
import type { ChatEvent, ChatHistory, ChatInput } from '../shared/assistant';
import { parsePageRange, pageLabel, type ChatFileInput } from '../shared/chat-files';
import type { FileInfo, NoteDetail, NoteNode, StorageInfo } from '../shared/types';
import { sseData } from '../shared/sse';
import { readApiKey } from '../worker/deepseek';
import { cleanup } from '../worker/recovery';
import { discardFile } from '../worker/storage';
import { AI_CONTEXT_WINDOW, inputTokenBudget } from '../shared/ai-context';
import {
  CHAT_BODY_BYTE_LIMIT,
  CHAT_SOURCE_TEXT_BYTE_LIMIT,
  CHAT_EVENT_CHARACTER_LIMIT,
} from '../shared/chat-files';

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const key = 'sk-test-only-fake-deepseek-key';
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1cAAAAASUVORK5CYII=';
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
function provider(content = '# 阅读结论\n\n解释所选文字。', complete: boolean | 'length' = true, reasoning = '') {
  const data = `: keepalive\r\n\r\n${reasoning ? `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] })}\n\n` : ''}data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\r\n\r\n${complete ? `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: complete === 'length' ? 'length' : 'stop' }] })}\n\ndata: [DONE]\n\n` : ''}`;
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
async function events(response: Response): Promise<ChatEvent[]> {
  expect(response.status).toBe(200);
  const result: ChatEvent[] = [];
  for await (const line of sseData(response.body!, CHAT_EVENT_CHARACTER_LIMIT))
    result.push(JSON.parse(line));
  return result;
}
async function chat(
  node: NoteNode,
  data: ChatInput = { content: '解释这段文字', quote: '被选中的文字' },
  options = {},
) {
  return events(await request(`/api/nodes/${node.id}/assistant`, 'POST', data, options));
}
async function history(node: NoteNode) {
  return ok<ChatHistory>(`/api/nodes/${node.id}/assistant`);
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
    bindings.DB.prepare('DELETE FROM assistant_threads'),
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

describe('per-file DeepSeek assistant', () => {
  it('retains explicit quote and file origins without adding navigation metadata to the provider prompt', async () => {
    const node = await create();
    await configure();
    const origin = { nodeId: node.id, title: '引用时的标题', section: '第一章', page: 2 };
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => provider());
    await chat(node, { content: '解释', quote: '选中文字', quoteSource: origin,
      files: [{ name: '原文', kind: 'markdown', text: '完整原文', images: [], origin }] });
    const user = (await history(node)).messages.find((message) => message.role === 'user')!;
    expect(user.quoteSource).toEqual(origin);
    expect(user.files![0].origin).toEqual(origin);
    expect(JSON.stringify(JSON.parse(String(fetch.mock.calls[0][1]?.body)).messages)).not.toContain('nodeId');
    fetch.mockClear();
    expect((await request(`/api/nodes/${node.id}/assistant`, 'POST', { content: '解释', quote: '选文', quoteSource: { nodeId: '../bad', title: '无效' } })).status).toBe(400);
    expect((await request(`/api/nodes/${node.id}/assistant`, 'POST', { content: '解释', quote: '选文', quoteSource: { ...origin, page: 0 } })).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('accepts private file uploads while read-only and refuses unsupported files', async () => {
    const node = await create(),
      bytes = new TextEncoder().encode('资料文本');
    expect((await uploadAttachment(node, 'reading.txt', bytes, true)).status).toBe(401);
    expect((await uploadAttachment(node, 'script.html', bytes)).status).toBe(400);
    expect(
      (await uploadAttachment(node, 'huge.txt', new Uint8Array(CHAT_SOURCE_TEXT_BYTE_LIMIT + 1)))
        .status,
    ).toBe(400);
    const response = await uploadAttachment(node, 'reading.txt', bytes);
    expect(response.status).toBe(201);
    const file = (await response.json()) as FileInfo;
    expect(await (await request(`/api/files/${file.id}`)).text()).toBe('资料文本');
    expect(
      (await request(`/api/files/${file.id}`, 'GET', undefined, { anonymous: true })).status,
    ).toBe(401);
    expect((await history(node)).messages).toHaveLength(0);
  });

  it('sends selected PDF pages and text snapshots, retaining file references through trash and cleanup', async () => {
    const node = await create();
    await configure();
    const pdf = (await (
      await uploadAttachment(
        node,
        'manual.pdf',
        new TextEncoder().encode('%PDF-1.4\noriginal-binary-not-for-provider'),
      )
    ).json()) as FileInfo;
    const image = (await (
      await uploadAttachment(
        node,
        'page.png',
        Uint8Array.from(atob(png.split(',')[1]), (c) => c.charCodeAt(0)),
      )
    ).json()) as FileInfo;
    const owner = await create('原 PDF', { kind: 'pdf', fileId: pdf.id });
    const files: ChatFileInput[] = [
      {
        name: 'manual.pdf',
        kind: 'pdf',
        sourceId: pdf.id,
        pages: [2, 3],
        pageCount: 10,
        mode: 'auto',
        text: '[第 2 页]\n桥梁结构文字',
        images: [{ blobId: image.id, page: 3 }],
      },
      { name: '当前笔记', kind: 'markdown', text: '# 当时附上的完整笔记', images: [] },
    ];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => provider());
    await chat(node, { content: '比较两个文件', files });
    const sent = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(JSON.stringify(sent)).toContain('本次仅提供第 2–3 页');
    expect(JSON.stringify(sent)).toContain('当时附上的完整笔记');
    expect(JSON.stringify(sent)).not.toContain('original-binary-not-for-provider');
    expect(sent.messages[1].content).toContainEqual({
      type: 'text',
      text: '附件图片：manual.pdf，第 3 页',
    });
    expect(sent.messages[1].content.at(-1).image_url.url).toBe(png);
    const original = await history(node);
    expect(original.messages[0].files?.[0]).toMatchObject({
      source: pdf,
      pages: [2, 3],
      images: [{ file: image, page: 3 }],
    });
    expect(await discardFile(bindings, image.id)).toBe(false);
    await cleanup(bindings);
    expect((await request(`/api/files/${image.id}`)).status).toBe(200);
    const storage = await ok<StorageInfo>('/api/storage');
    expect(storage.orphanBytes).toBe(0);
    expect(storage.currentBytes).toBe(storage.allocatedBytes);
    const trash = await ok<{ id: string }>(`/api/nodes/${node.id}`, 'DELETE', { count: 1 });
    await cleanup(bindings);
    expect((await request(`/api/files/${image.id}`)).status).toBe(200);
    expect((await ok<StorageInfo>('/api/storage')).trashBytes).toBeGreaterThan(image.size);
    await ok(`/api/trash/${trash.id}/restore`, 'POST', {});
    expect((await history(node)).messages).toEqual(original.messages);
    await ok(`/api/nodes/${node.id}/assistant`, 'DELETE');
    await cleanup(bindings);
    expect((await request(`/api/files/${image.id}`)).status).toBe(404);
    expect((await request(`/api/files/${pdf.id}`)).status).toBe(200);
    expect((await ok<NoteDetail>(`/api/nodes/${owner.id}`)).file?.id).toBe(pdf.id);
  });

  it('includes every current PDF image along with the screenshot within the history budget', async () => {
    const node = await create();
    await configure();
    const image = (await (
      await uploadAttachment(
        node,
        'page.png',
        Uint8Array.from(atob(png.split(',')[1]), (c) => c.charCodeAt(0)),
      )
    ).json()) as FileInfo;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => provider());
    const pages = [1, 2, 3, 4, 5, 6];
    const files: ChatFileInput[] = [
      {
        name: 'scans.pdf',
        kind: 'pdf',
        pageCount: 12,
        pages,
        mode: 'images',
        text: '',
        images: pages.map((page) => ({ blobId: image.id, page })),
      },
    ];
    await chat(node, { content: '旧问题', image: png, files });
    const result = await chat(node, { content: '现在的问题', image: png, files });
    const sent = JSON.parse(String(fetch.mock.calls[1][1]?.body));
    const current = sent.messages.at(-1).content;
    expect(current.filter((part: { type: string }) => part.type === 'image_url')).toHaveLength(7);
    expect(current).toContainEqual({ type: 'text', text: '附件图片：scans.pdf，第 6 页' });
    expect(JSON.stringify(sent)).not.toContain('旧问题');
    expect(result[0]).toMatchObject({ type: 'start', context: { omittedHistory: true } });
    expect(
      sent.messages
        .flatMap((m: { content: unknown }) => (Array.isArray(m.content) ? m.content : []))
        .filter((p: { type: string }) => p.type === 'image_url'),
    ).toHaveLength(7);
  });

  it('rejects excessive or inconsistent attachment metadata before a paid request', async () => {
    const node = await create();
    await configure();
    const file = (await (
      await uploadAttachment(node, 'wrong.md', new TextEncoder().encode('%PDF-1.4\nfixture'))
    ).json()) as FileInfo;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => provider());
    const basic = { name: 'note.md', kind: 'markdown', text: '内容', images: [] };
    const pdf = {
      name: 'book.pdf',
      kind: 'pdf',
      text: '[第 1 页] 文本',
      pages: [1],
      pageCount: 3,
      mode: 'auto',
      images: [],
    };
    for (const files of [
      [basic, basic, basic, basic],
      [{ ...basic, text: '*'.repeat(870_000) }],
      [{ ...basic, sourceId: file.id }],
      [{ ...pdf, pages: [0] }],
      [{ ...pdf, pages: [4] }],
      [{ ...pdf, pages: [1, 1] }],
      [{ ...pdf, mode: 'images' }],
      [{ ...pdf, images: [{ blobId: file.id, page: 2 }] }],
      [{ ...pdf, images: Array.from({ length: 7 }, (_, i) => ({ blobId: file.id, page: i + 1 })) }],
    ])
      expect(
        (await request(`/api/nodes/${node.id}/assistant`, 'POST', { content: '问', files }, {}))
          .status,
      ).toBeGreaterThanOrEqual(400);
    expect(fetch).not.toHaveBeenCalled();
    expect((await history(node)).messages).toHaveLength(0);
    expect((await history(node)).busy).toBe(false);
  });

  it('parses bounded page ranges without silently truncating or repeating pages', () => {
    expect(parsePageRange('1-3，5,2,8-9', 10)).toEqual([1, 2, 3, 5, 8, 9]);
    expect(pageLabel([1, 2, 3, 5, 8, 9])).toBe('1–3、5、8–9');
    for (const value of ['', '0', '3-2', '1-11', '1,', '1.5'])
      expect(() => parsePageRange(value, 10)).toThrow();
    expect(() => parsePageRange('1-201', 300)).toThrow('200');
  });

  it('sends complete long PDF text and a text attachment larger than 1 MiB, retaining their snapshots', async () => {
    const node = await create();
    await configure();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => provider());
    const text = 'Long research text. '.repeat(60_000) + 'END OF TEXT';
    const pdfText = '[第 1 页]\n' + '论文公式 $x_i + y_i$. '.repeat(10_000) + 'PDF END';
    const response = await uploadAttachment(node, 'long.txt', new TextEncoder().encode(text));
    expect(response.status).toBe(201);
    const source = (await response.json()) as FileInfo;
    const files: ChatFileInput[] = [
      { name: 'long.txt', kind: 'text', text, sourceId: source.id, images: [] },
      {
        name: 'long.pdf',
        kind: 'pdf',
        text: pdfText,
        pageCount: 1,
        pages: [1],
        mode: 'auto',
        images: [],
      },
    ];
    const result = await chat(node, { content: '比较这两份资料', files });
    expect(result.at(-1)).toMatchObject({ type: 'done' });
    const sent = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(sent.messages[1].content).toContain(text);
    expect(sent.messages[1].content).toContain(pdfText);
    expect(result[0]).toMatchObject({
      type: 'start',
      context: {
        contextWindow: AI_CONTEXT_WINDOW,
        reservedOutputTokens: 8192,
        omittedHistory: false,
      },
    });
    const stored = (await history(node)).messages[0].files!;
    expect(stored.map((file) => file.text)).toEqual([text, pdfText]);
    expect(await discardFile(bindings, source.id)).toBe(false);
    const storage = await ok<StorageInfo>('/api/storage');
    expect(storage.orphanBytes).toBe(0);
  });

  it('reserves output tokens, rejects an oversized turn without saving or charging, and allows the same request to retry', async () => {
    const node = await create();
    await configure();
    await ok('/api/ai/settings', 'PUT', { maxTokens: 32768 });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => provider());
    const data: ChatInput = {
      content: '完整读取',
      image: png,
      files: [
        {
          name: 'formula.txt',
          kind: 'text',
          text: '*'.repeat(inputTokenBudget(8192) - 5000),
          images: [],
        },
      ],
    };
    const storage = await ok<StorageInfo>('/api/storage');
    const response = await request(`/api/nodes/${node.id}/assistant`, 'POST', data, {
      key: 'budget-retry',
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('32,768'),
      code: 'AI_CONTEXT_LIMIT',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect((await history(node)).messages).toHaveLength(0);
    expect((await history(node)).busy).toBe(false);
    expect((await ok<StorageInfo>('/api/storage')).allocatedBytes).toBe(storage.allocatedBytes);
    await ok('/api/ai/settings', 'PUT', { maxTokens: 8192 });
    expect((await chat(node, data, { key: 'budget-retry' })).at(-1)).toMatchObject({
      type: 'done',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('paginates large attachment history by bytes without losing or truncating messages', async () => {
    const node = await create();
    await configure();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => provider('已读。'));
    const text = '字'.repeat(1_000_000);
    for (let index = 0; index < 3; index++)
      await chat(node, {
        content: `阅读 ${index}`,
        files: [{ name: 'long.txt', kind: 'text', text, images: [] }],
      });
    const first = await history(node);
    expect(first.messages.length).toBeLessThan(6);
    expect(first.nextBefore).not.toBeNull();
    const older = await ok<ChatHistory>(
      `/api/nodes/${node.id}/assistant?before=${first.nextBefore}`,
    );
    expect(older.nextBefore).toBeNull();
    const all = [...older.messages, ...first.messages];
    expect(all).toHaveLength(6);
    expect(new Set(all.map((message) => message.id)).size).toBe(6);
    expect(
      all.filter((message) => message.role === 'user').map((message) => message.files![0].text),
    ).toEqual([text, text, text]);
  });

  it('follows an older continuation outside the recent metadata page without unrelated turns', async () => {
    const node = await create();
    await configure();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => provider('原回复断点。', 'length'));
    await chat(node, { content: '最初问题', quote: '原始资料' });
    const reply = (await history(node)).messages[1];
    fetch.mockImplementation(async () => provider('后续回答。'));
    for (let index = 0; index < 12; index++) await chat(node, { content: `无关问题 ${index}` });
    fetch.mockClear();
    await chat(node, { content: '继续生成', continueFrom: reply.id });
    const sent = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(sent.messages).toHaveLength(4);
    expect(sent.messages[1].content).toContain('原始资料');
    expect(sent.messages[2]).toEqual({ role: 'assistant', content: '原回复断点。' });
    expect(JSON.stringify(sent.messages)).not.toContain('无关问题');
  });

  it('drops only older whole turns when text plus recent history exceeds the input budget', async () => {
    const node = await create();
    await configure();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => provider());
    const file = (text: string): ChatFileInput => ({
      name: 'source.txt',
      kind: 'text',
      text,
      images: [],
    });
    const oldest = file('*'.repeat(400_000) + ' OLD END');
    const recent = file('*'.repeat(100_000) + ' RECENT END');
    const current = file('*'.repeat(400_000) + ' CURRENT END');
    await chat(node, { content: '最早问题', files: [oldest] });
    await chat(node, { content: '最近问题', files: [recent] });
    const result = await chat(node, { content: '现在问题', files: [current] });
    expect(result[0]).toMatchObject({ type: 'start', context: { omittedHistory: true } });
    const sent = JSON.parse(String(fetch.mock.calls[2][1]?.body));
    expect(sent.messages).toHaveLength(4);
    expect(sent.messages[1]).toMatchObject({
      role: 'user',
      content: expect.stringContaining(recent.text),
    });
    expect(sent.messages[2].role).toBe('assistant');
    expect(sent.messages[3].content).toContain(current.text);
    expect(JSON.stringify(sent.messages)).not.toContain('OLD END');
    const saved = await history(node);
    expect(saved.messages).toHaveLength(6);
    expect(saved.messages[0].files![0].text).toBe(oldest.text);
  });

  it('refuses an over-budget continuation without discarding its original question or partial reply', async () => {
    const node = await create();
    await configure();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => provider('*'.repeat(10_000), 'length'));
    await chat(node, {
      content: '原问题',
      files: [
        {
          name: 'large.txt',
          kind: 'text',
          text: '*'.repeat(inputTokenBudget(8192) - 2000),
          images: [],
        },
      ],
    });
    const saved = await history(node);
    const partial = saved.messages.at(-1)!;
    expect(partial.status).toBe('interrupted');
    const response = await request(`/api/nodes/${node.id}/assistant`, 'POST', {
      content: '继续生成',
      continueFrom: partial.id,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'AI_CONTEXT_LIMIT' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await history(node)).messages).toEqual(saved.messages);
    expect((await history(node)).busy).toBe(false);
  });

  it('identifies provider tokenizer overflow without retrying or truncating the submitted file', async () => {
    const node = await create();
    await configure();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json(
        {
          error: { code: 'context_length_exceeded', message: 'provider-private-details' },
        },
        { status: 400 },
      ),
    );
    const files: ChatFileInput[] = [
      { name: 'research.md', kind: 'markdown', text: '全文尾部。'.repeat(20_000), images: [] },
    ];
    const result = await chat(node, { content: '分析', files });
    expect(result.at(-1)).toMatchObject({
      type: 'error',
      error: expect.stringContaining('实际分词后超出上下文容量'),
    });
    expect(JSON.stringify(result)).not.toContain('provider-private-details');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await history(node)).messages[0].files![0].text).toBe(files[0].text);
  });

  it('reports the separate request byte guard before reading an oversized chat body', async () => {
    const node = await create();
    const context = createExecutionContext();
    contexts.push(context);
    const response = await worker.fetch(
      new Request(`https://notes.test/api/nodes/${node.id}/assistant`, {
        method: 'POST',
        headers: {
          cookie,
          origin: 'https://notes.test',
          'content-type': 'application/json',
          'content-length': String(CHAT_BODY_BYTE_LIMIT + 1),
        },
        body: '{}',
      }),
      bindings,
      context,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('16 MiB') });
    expect((await history(node)).messages).toHaveLength(0);
  });
  it('keeps settings private, encrypts the key, and tests only the fixed provider', async () => {
    expect((await request('/api/ai/settings', 'GET', undefined, { anonymous: true })).status).toBe(
      401,
    );
    expect(
      (await request('/api/ai/settings', 'PUT', { apiKey: key }, { anonymous: true })).status,
    ).toBe(401);
    expect(
      (
        await request(
          '/api/ai/settings',
          'PUT',
          { apiKey: key },
          { origin: 'https://elsewhere.test' },
        )
      ).status,
    ).toBe(403);
    await configure();
    expect(await ok('/api/ai/settings')).toEqual({
      configured: true,
      model: 'deepseek-flash',
      maxTokens: 8192,
      thinkingLevel: 'none',
    });
    const row = await bindings.DB.prepare('SELECT encrypted_key FROM ai_settings').first<{
      encrypted_key: string;
    }>();
    expect(row!.encrypted_key).not.toContain(key);
    expect(await readApiKey(bindings)).toBe(key);
    await expect(readApiKey({ ...bindings, APP_SECRET: 'changed-secret' })).rejects.toThrow(
      '重新保存',
    );
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'deepseek-flash' }] })));
    await ok('/api/ai/test', 'POST', {});
    expect(fetch.mock.calls[0][0]).toBe('https://api.deepseek.com/models');
    expect(fetch.mock.calls[0][1]?.headers).toMatchObject({ authorization: `Bearer ${key}` });
    await ok('/api/ai/settings', 'DELETE');
    expect(await ok('/api/ai/settings')).toMatchObject({ configured: false });
  });

  it('defaults to 8192 tokens and changes the reply limit without replacing the saved key', async () => {
    expect(await ok('/api/ai/settings')).toMatchObject({ configured: false, maxTokens: 8192 });
    await configure();
    const node = await create();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => provider());
    await chat(node);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
      max_tokens: 8192,
      thinking: { type: 'disabled' },
    });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).not.toHaveProperty('reasoning_effort');
    const encrypted = await bindings.DB.prepare('SELECT encrypted_key FROM ai_settings').first();
    expect(await ok('/api/ai/settings', 'PUT', { maxTokens: 16384 })).toMatchObject({
      maxTokens: 16384,
    });
    expect(await bindings.DB.prepare('SELECT encrypted_key FROM ai_settings').first()).toEqual(
      encrypted,
    );
    expect(await readApiKey(bindings)).toBe(key);
    await chat(node);
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).max_tokens).toBe(16384);
    for (const maxTokens of [0, -1, 8192.5, '8192', 65536])
      expect((await request('/api/ai/settings', 'PUT', { maxTokens })).status).toBe(400);
    await configure();
    expect(await ok('/api/ai/settings')).toMatchObject({ maxTokens: 16384 });
    await ok('/api/ai/settings', 'DELETE');
    expect(await ok('/api/ai/settings')).toMatchObject({ configured: false, maxTokens: 8192 });
  });

  it('streams and saves reasoning in file and global chats without adding it to later prompts', async () => {
    expect(await ok('/api/ai/settings')).toMatchObject({ thinkingLevel: 'none' });
    await ok('/api/ai/settings', 'PUT', { apiKey: key, thinkingLevel: 'high' });
    const encrypted = await bindings.DB.prepare('SELECT encrypted_key FROM ai_settings').first();
    const node = await create();
    const reasoning = '先检查问题中的条件，再逐步比较。';
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
      provider('正式回答。', true,
        JSON.parse(String(init?.body)).thinking.type === 'enabled' ? reasoning : ''),
    );
    for (const thinkingLevel of ['low', 'high', 'max', 'none']) {
      expect(await ok('/api/ai/settings', 'PUT', { thinkingLevel })).toMatchObject({ thinkingLevel });
      expect(await ok('/api/ai/settings')).toMatchObject({ thinkingLevel, maxTokens: 8192 });
      for (const id of [node.id, GLOBAL_ASSISTANT_ID]) {
        const result = await events(await request(`/api/nodes/${id}/assistant`, 'POST', { content: '解释一下。' }));
        expect(result.at(-1)).toMatchObject({ type: 'done', message: { content: '正式回答。' } });
        const saved = (await ok<ChatHistory>(`/api/nodes/${id}/assistant`)).messages.at(-1)!;
        expect(saved.content).toBe('正式回答。');
        if (thinkingLevel === 'none') {
          expect(result.some((event) => event.type === 'reasoning')).toBe(false);
          expect(saved.reasoning).toBeUndefined();
        } else {
          expect(result).toContainEqual({ type: 'reasoning', content: reasoning });
          expect(result.at(-1)).toMatchObject({ message: { reasoning } });
          expect(saved.reasoning).toBe(reasoning);
        }
        const sent = JSON.parse(String(fetch.mock.lastCall?.[1]?.body));
        expect(sent.thinking).toEqual({ type: thinkingLevel === 'none' ? 'disabled' : 'enabled' });
        if (thinkingLevel === 'none') expect(sent).not.toHaveProperty('reasoning_effort');
        else expect(sent.reasoning_effort).toBe(thinkingLevel);
        expect(JSON.stringify(sent.messages)).not.toContain(reasoning);
      }
    }
    expect(await bindings.DB.prepare('SELECT encrypted_key FROM ai_settings').first()).toEqual(encrypted);
    await ok('/api/ai/settings', 'PUT', { thinkingLevel: 'max' });
    await ok('/api/ai/settings', 'PUT', { maxTokens: 16384 });
    await configure();
    expect(await ok('/api/ai/settings')).toMatchObject({ thinkingLevel: 'max', maxTokens: 16384 });
    await ok('/api/ai/settings', 'DELETE');
    expect(await ok('/api/ai/settings')).toMatchObject({ configured: false, thinkingLevel: 'none' });
    const answer = (await history(node)).messages.find((message) => message.reasoning)!;
    const exported = await ok<NoteNode>(`/api/nodes/${node.id}/assistant/${answer.id}/export`, 'POST', {});
    expect((await ok<NoteDetail>(`/api/nodes/${exported.id}`)).content).toBe('正式回答。');
  });

  it('rejects unsupported thinking depths without changing the saved configuration', async () => {
    await ok('/api/ai/settings', 'PUT', { apiKey: key, thinkingLevel: 'low' });
    for (const thinkingLevel of ['', 'medium', 'ultra', 'HIGH', null, 1, {}, ['high']]) {
      const response = await request('/api/ai/settings', 'PUT', {
        apiKey: 'sk-replacement-that-must-not-be-saved', maxTokens: 32768, thinkingLevel,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: '请选择支持的思考深度。' });
    }
    expect(await ok('/api/ai/settings')).toMatchObject({ thinkingLevel: 'low', maxTokens: 8192 });
    expect(await readApiKey(bindings)).toBe(key);
  });

  it('explains a thinking-only length limit and does not retry the paid request', async () => {
    await ok('/api/ai/settings', 'PUT', { apiKey: key, thinkingLevel: 'max' });
    const node = await create();
    const reasoning = '需要进一步检查假设。';
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => provider('', 'length', reasoning));
    const result = await chat(node);
    expect(result.at(-1)).toMatchObject({
      type: 'error', error: expect.stringContaining('降低思考深度'),
      message: { status: 'failed', content: '', reasoning },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await history(node)).busy).toBe(false);
    expect((await history(node)).messages.at(-1)?.reasoning).toBe(reasoning);
  });

  it('retains received reasoning after a provider disconnect and bounds combined generation size', async () => {
    await ok('/api/ai/settings', 'PUT', { apiKey: key, thinkingLevel: 'high' });
    const node = await create();
    const reasoning = '已收到的思考内容';
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => provider('', false, reasoning));
    expect((await chat(node)).at(-1)).toMatchObject({
      type: 'error', message: { content: '', reasoning, status: 'failed' },
    });
    expect((await history(node)).messages.at(-1)?.reasoning).toBe(reasoning);
    fetch.mockImplementation(async () => new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(AI_RESPONSE_CHARACTER_LIMIT) } }] })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    ));
    expect((await chat(node)).at(-1)).toMatchObject({
      type: 'error', error: expect.stringContaining('内容过大'),
      message: { content: '', reasoning },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await history(node)).busy).toBe(false);
  });

  it('keeps reasoning when stopped before the answer without sending an empty assistant turn later', async () => {
    await ok('/api/ai/settings', 'PUT', { apiKey: key, thinkingLevel: 'high' });
    const node = await create();
    const reasoning = '停止前已收到的思考。';
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode(
            `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] })}\n\n`,
          ));
          init?.signal?.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')), { once: true });
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    ));
    const controller = new AbortController();
    const response = await request(`/api/nodes/${node.id}/assistant`, 'POST', { content: '先思考' }, { signal: controller.signal });
    const result: ChatEvent[] = [];
    for await (const line of sseData(response.body!)) {
      const event = JSON.parse(line) as ChatEvent;
      result.push(event);
      if (event.type === 'reasoning') controller.abort();
    }
    expect(result.at(-1)).toMatchObject({
      type: 'error', message: { status: 'interrupted', content: '', reasoning },
    });
    const saved = (await history(node)).messages.at(-1)!;
    expect(saved.reasoning).toBe(reasoning);
    expect((await request(`/api/nodes/${node.id}/assistant/${saved.id}/export`, 'POST', {})).status).toBe(400);
    expect((await request(`/api/nodes/${node.id}/assistant`, 'POST', { content: '继续生成', continueFrom: saved.id })).status).toBe(400);
    fetch.mockImplementation(async () => provider('新的回答'));
    expect((await chat(node)).at(-1)).toMatchObject({ type: 'done' });
    const messages = JSON.parse(String(fetch.mock.lastCall?.[1]?.body)).messages;
    expect(messages.some((message: { role: string; content: string }) => message.role === 'assistant')).toBe(false);
    expect(JSON.stringify(messages)).not.toContain(reasoning);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('continues a length-limited reply with its original context and exports the partial reply once', async () => {
    const node = await create(),
      other = await create('另一个文件');
    await configure();
    const partial = '# 未完的分析\n\n第一部分。';
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => provider(partial, 'length'));
    expect((await chat(node)).at(-1)).toMatchObject({
      type: 'error',
      message: { status: 'interrupted', content: partial },
    });
    const answer = (await history(node)).messages[1];
    const child = await ok<NoteNode>(
      `/api/nodes/${node.id}/assistant/${answer.id}/export`,
      'POST',
      {},
    );
    expect(child.parent_id).toBe(node.id);
    expect((await ok<NoteDetail>(`/api/nodes/${child.id}`)).content).toBe(partial);
    expect(
      (await ok<NoteNode>(`/api/nodes/${node.id}/assistant/${answer.id}/export`, 'POST', {})).id,
    ).toBe(child.id);
    fetch.mockImplementation(async () => provider('第二部分，完成。'));
    await chat(node, { content: '后来的无关问题' });
    fetch.mockImplementationOnce(async () => provider('第二部分，还没写完。', 'length'));
    const continuation = { content: '继续生成', continueFrom: answer.id };
    await events(
      await request(`/api/nodes/${node.id}/assistant`, 'POST', continuation, {
        key: 'continue-once',
      }),
    );
    const sent = JSON.parse(String(fetch.mock.calls[2][1]?.body));
    expect(sent.messages.slice(1, -1)).toEqual([
      { role: 'user', content: '解释这段文字\n\n<引用文字>\n被选中的文字\n</引用文字>' },
      { role: 'assistant', content: partial },
    ]);
    expect(sent.messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('继续'),
    });
    expect(sent.max_tokens).toBe(8192);
    expect(
      (
        await request(`/api/nodes/${node.id}/assistant`, 'POST', continuation, {
          key: 'continue-once',
        })
      ).status,
    ).toBe(409);
    expect((await request(`/api/nodes/${other.id}/assistant`, 'POST', continuation)).status).toBe(
      404,
    );
    expect(
      (
        await request(`/api/nodes/${node.id}/assistant`, 'POST', {
          ...continuation,
          continueFrom: (await history(node)).messages[0].id,
        })
      ).status,
    ).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(3);
    const second = (await history(node)).messages.at(-1)!;
    await events(
      await request(`/api/nodes/${node.id}/assistant`, 'POST', {
        content: '继续生成',
        continueFrom: second.id,
      }),
    );
    const repeated = JSON.parse(String(fetch.mock.calls[3][1]?.body));
    expect(JSON.stringify(repeated.messages)).not.toContain('后来的无关问题');
    expect(JSON.stringify(repeated.messages)).toContain(partial.replaceAll('\n', '\\n'));
    expect(JSON.stringify(repeated.messages)).toContain('第二部分，还没写完。');
    expect(JSON.stringify(repeated.messages)).toContain('被选中的文字');
    expect((await history(node)).messages.at(-1)).toMatchObject({
      status: 'completed',
      content: '第二部分，完成。',
    });
  });

  it('retains the original file and screenshot when a long reply exceeds the usual history budget', async () => {
    const node = await create();
    await configure();
    const partial = '已生成的内容。'.repeat(15_000);
    const fileText = '资料原文。'.repeat(10_000);
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => provider(partial, 'length'));
    await chat(node, {
      content: '分析资料',
      quote: '原始引用',
      image: png,
      files: [{ name: 'reference.txt', kind: 'text', text: fileText, images: [] }],
    });
    const answer = (await history(node)).messages.at(-1)!;
    expect(answer.content).toBe(partial);
    fetch.mockImplementationOnce(async () => provider('续写内容。'));
    await events(
      await request(`/api/nodes/${node.id}/assistant`, 'POST', {
        content: '继续生成',
        continueFrom: answer.id,
      }),
    );
    const sent = JSON.parse(String(fetch.mock.calls[1][1]?.body));
    expect(sent.messages[1].content[0].text).toContain(fileText);
    expect(sent.messages[1].content[0].text).toContain('原始引用');
    expect(sent.messages[1].content[1].image_url.url).toBe(png);
    expect(sent.messages[2]).toEqual({ role: 'assistant', content: partial });
  });

  it('streams UTF-8, isolates file context and history, and exports once under the source file', async () => {
    const first = await create(),
      second = await create('资料 B');
    expect(
      (await request(`/api/nodes/${first.id}/assistant`, 'POST', { content: '问' })).status,
    ).toBe(400);
    await configure();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => provider());
    const stream = await chat(first);
    expect(stream.map((e) => e.type)).toEqual(['start', 'delta', 'done']);
    expect(stream[1]).toMatchObject({ type: 'delta', content: '# 阅读结论\n\n解释所选文字。' });
    const payload = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(payload).toMatchObject({
      model: 'deepseek-flash',
      thinking: { type: 'disabled' },
      stream: true,
    });
    expect(JSON.stringify(payload)).toContain('被选中的文字');
    expect(JSON.stringify(payload)).not.toContain('未经引用的私密全文');
    expect((await history(first)).messages).toHaveLength(2);
    expect((await history(second)).messages).toHaveLength(0);
    await chat(first, { content: '再简短一些', quote: '' });
    expect(JSON.stringify(JSON.parse(String(fetch.mock.calls[1][1]?.body)).messages)).toContain(
      '阅读结论',
    );
    await chat(second, { content: '新话题', quote: '' });
    expect(JSON.stringify(JSON.parse(String(fetch.mock.calls[2][1]?.body)).messages)).not.toContain(
      '被选中的文字',
    );
    const answer = (await history(first)).messages[1];
    expect(
      (
        await request(
          `/api/nodes/${first.id}/assistant/${answer.id}/export`,
          'POST',
          {},
          { anonymous: true },
        )
      ).status,
    ).toBe(401);
    const saved = await ok<NoteNode>(
      `/api/nodes/${first.id}/assistant/${answer.id}/export`,
      'POST',
      {},
    );
    expect(saved).toMatchObject({ parent_id: first.id, kind: 'markdown', title: '阅读结论' });
    expect((await ok<NoteDetail>(`/api/nodes/${saved.id}`)).content).toBe(answer.content);
    await bindings.DB.prepare('DELETE FROM idempotency').run();
    expect(
      (await ok<NoteNode>(`/api/nodes/${first.id}/assistant/${answer.id}/export`, 'POST', {})).id,
    ).toBe(saved.id);
    expect(
      (await request(`/api/nodes/${second.id}/assistant/${answer.id}/export`, 'POST', {})).status,
    ).toBe(404);
    expect((await ok<NoteDetail>(`/api/nodes/${first.id}`)).revision).toBe(first.revision);
  });

  it('retains private screenshots through cleanup and trash restore, then reclaims cleared chat', async () => {
    const node = await create();
    await configure();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => provider());
    await events(
      await request(
        `/api/nodes/${node.id}/assistant`,
        'POST',
        { content: '解释截图', image: png },
        {},
      ),
    );
    const sent = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(sent.messages[1].content[1].image_url.url).toBe(png);
    const original = await history(node),
      screenshot = original.messages[0].image!;
    expect(
      (await request(`/api/files/${screenshot.id}`, 'GET', undefined, { anonymous: true })).status,
    ).toBe(401);
    expect(await discardFile(bindings, screenshot.id)).toBe(false);
    await cleanup(bindings);
    expect((await request(`/api/files/${screenshot.id}`)).status).toBe(200);
    const storage = await ok<StorageInfo>('/api/storage');
    expect(storage.currentBytes).toBe(storage.allocatedBytes);
    expect(storage.orphanBytes).toBe(0);
    const trash = await ok<{ id: string }>(`/api/nodes/${node.id}`, 'DELETE', { count: 1 });
    expect((await request(`/api/nodes/${node.id}/assistant`)).status).toBe(410);
    expect((await ok<StorageInfo>('/api/storage')).trashBytes).toBe(storage.currentBytes);
    await ok(`/api/trash/${trash.id}/restore`, 'POST', {});
    expect((await history(node)).messages).toEqual(original.messages);
    const saved = await ok<NoteNode>(
      `/api/nodes/${node.id}/assistant/${original.messages[1].id}/export`,
      'POST',
      {},
    );
    await ok(`/api/nodes/${node.id}/assistant`, 'DELETE');
    await cleanup(bindings);
    expect((await history(node)).messages).toHaveLength(0);
    expect((await request(`/api/files/${screenshot.id}`)).status).toBe(404);
    expect((await ok<NoteDetail>(`/api/nodes/${saved.id}`)).content).toContain('阅读结论');
  });

  it('allows PDF and image files to own assistant notes and preserves cycle protection', async () => {
    await configure();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => provider());
    for (const kind of ['pdf', 'image']) {
      const bytes =
        kind === 'pdf'
          ? new TextEncoder().encode('%PDF-1.4\nfixture')
          : Uint8Array.from(atob(png.split(',')[1]), (c) => c.charCodeAt(0));
      const context = createExecutionContext();
      contexts.push(context);
      const response = await worker.fetch(
        new Request(`https://notes.test/api/files?name=fixture.${kind}&size=${bytes.byteLength}`, {
          method: 'POST',
          headers: { origin: 'https://notes.test', cookie },
          body: bytes,
        }),
        bindings,
        context,
      );
      const file = (await response.json()) as FileInfo;
      const node = await create(kind, { kind, fileId: file.id });
      await chat(node);
      const answer = (await history(node)).messages[1];
      const child = await ok<NoteNode>(
        `/api/nodes/${node.id}/assistant/${answer.id}/export`,
        'POST',
        {},
      );
      expect(child.parent_id).toBe(node.id);
      expect(
        (
          await request(`/api/nodes/${node.id}`, 'PATCH', {
            revision: node.revision,
            parentId: child.id,
          })
        ).status,
      ).toBe(400);
    }
  });

  it('rejects invalid and oversized content before calling the provider, respects quota, and unlocks failures', async () => {
    const node = await create();
    await configure();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => provider());
    for (const data of [
      { content: '问'.repeat(8001) },
      { content: '问', quote: '字'.repeat(20001) },
      { content: '问', image: 'data:image/png;base64,bm90LWFuLWltYWdl' },
      { content: '问', image: `data:image/png;base64,${'a'.repeat(1_400_000)}` },
    ]) {
      expect(
        (await request(`/api/nodes/${node.id}/assistant`, 'POST', data)).status,
      ).toBeGreaterThanOrEqual(400);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect((await history(node)).messages).toHaveLength(0);
    await bindings.DB.prepare('UPDATE site SET quota_bytes=allocated_bytes WHERE id=1').run();
    expect(
      (await request(`/api/nodes/${node.id}/assistant`, 'POST', { content: '问' })).status,
    ).toBe(413);
    expect((await history(node)).busy).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('marks truncated and failed replies, avoids duplicate requests, and permits a later question', async () => {
    const node = await create();
    await configure();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => provider('部分回复', false));
    const result = await chat(node, undefined, { key: 'request-once' });
    expect(result.at(-1)).toMatchObject({
      type: 'error',
      message: { status: 'interrupted', content: '部分回复' },
    });
    const answer = (await history(node)).messages[1];
    const saved = await ok<NoteNode>(
      `/api/nodes/${node.id}/assistant/${answer.id}/export`,
      'POST',
      {},
    );
    expect((await ok<NoteDetail>(`/api/nodes/${saved.id}`)).content).toBe('部分回复');
    expect(
      (
        await request(
          `/api/nodes/${node.id}/assistant`,
          'POST',
          { content: '重复' },
          { key: 'request-once' },
        )
      ).status,
    ).toBe(409);
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockImplementationOnce(
      async () => new Response('secret error response is not reflected', { status: 402 }),
    );
    expect((await chat(node)).at(-1)).toMatchObject({
      type: 'error',
      error: expect.stringContaining('余额不足'),
      message: { status: 'failed' },
    });
    expect((await history(node)).busy).toBe(false);
    fetch.mockImplementationOnce(async () => provider('后来完整的回复'));
    expect((await chat(node)).at(-1)).toMatchObject({ type: 'done' });
  });

  it('serializes a file across devices and stops an active provider request', async () => {
    const node = await create();
    await configure();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: '停止前已生成的内容。' } }] })}\n\n`,
                ),
              );
              started();
              init?.signal?.addEventListener(
                'abort',
                () => controller.error(new DOMException('Aborted', 'AbortError')),
                { once: true },
              );
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const controller = new AbortController();
    const response = await request(
      `/api/nodes/${node.id}/assistant`,
      'POST',
      { content: '等待回复' },
      { signal: controller.signal },
    );
    const consuming = events(response);
    await ready;
    expect((await history(node)).busy).toBe(true);
    const pending = (await history(node)).messages.at(-1)!;
    expect(
      (await request(`/api/nodes/${node.id}/assistant/${pending.id}/export`, 'POST', {})).status,
    ).toBe(400);
    expect(
      (
        await request(`/api/nodes/${node.id}/assistant`, 'POST', {
          content: '继续生成',
          continueFrom: pending.id,
        })
      ).status,
    ).toBe(400);
    const lock = await bindings.DB.prepare(
      'SELECT locked_until FROM assistant_threads WHERE node_id=?',
    )
      .bind(node.id)
      .first<{ locked_until: number }>();
    expect(lock!.locked_until - Date.now()).toBeGreaterThan(300_000);
    expect(
      (await request(`/api/nodes/${node.id}/assistant`, 'POST', { content: '并行请求' })).status,
    ).toBe(409);
    expect((await request(`/api/nodes/${node.id}/assistant`, 'DELETE')).status).toBe(409);
    controller.abort();
    expect((await consuming).at(-1)).toMatchObject({
      type: 'error',
      message: { status: 'interrupted', content: '停止前已生成的内容。' },
    });
    expect((await history(node)).busy).toBe(false);
    const saved = await ok<NoteNode>(
      `/api/nodes/${node.id}/assistant/${pending.id}/export`,
      'POST',
      {},
    );
    expect((await ok<NoteDetail>(`/api/nodes/${saved.id}`)).content).toBe('停止前已生成的内容。');
    fetch.mockImplementationOnce(async () => provider('停止后的续写。'));
    await events(
      await request(`/api/nodes/${node.id}/assistant`, 'POST', {
        content: '继续生成',
        continueFrom: pending.id,
      }),
    );
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).messages).toContainEqual({
      role: 'assistant',
      content: '停止前已生成的内容。',
    });
  });
});

it('isolates global history, accepts attachments and exports to the library root', async () => {
  await configure();
  const file = await create();
  const global = { ...file, id: GLOBAL_ASSISTANT_ID };
  expect(
    (await request(`/api/nodes/${global.id}/assistant`, 'GET', undefined, { anonymous: true }))
      .status,
  ).toBe(401);
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => provider('# 全局结论'));
  const attachment = (await (
    await uploadAttachment(global, 'global.txt', new TextEncoder().encode('全局附件'))
  ).json()) as FileInfo;
  await chat(global, {
    content: '全局问题',
    files: [
      { name: 'global.txt', kind: 'text', sourceId: attachment.id, text: '全局附件', images: [] },
    ],
  });
  await Promise.all(contexts.map(waitOnExecutionContext));
  const globalHistory = await history(global);
  expect(globalHistory.messages).toHaveLength(2);
  expect((await history(file)).messages).toHaveLength(0);
  const sent = JSON.parse(String(fetch.mock.calls[0][1]?.body));
  expect(JSON.stringify(sent)).toContain('独立的全局对话');
  expect(JSON.stringify(sent)).not.toContain(file.title);
  const reply = globalHistory.messages.find((m) => m.role === 'assistant')!;
  const saved = await ok<NoteNode>(
    `/api/nodes/${global.id}/assistant/${reply.id}/export`,
    'POST',
    {},
  );
  expect(saved.parent_id).toBeNull();
  const storage = await ok<StorageInfo>('/api/storage');
  expect(storage.trashBytes).toBe(0);
  await chat(file);
  await Promise.all(contexts.map(waitOnExecutionContext));
  expect((await history(global)).messages).toHaveLength(2);
  await ok(`/api/nodes/${global.id}/assistant`, 'DELETE');
  expect((await history(global)).messages).toHaveLength(0);
  expect((await history(file)).messages).toHaveLength(2);
  expect((await request(`/api/nodes/${saved.id}`)).status).toBe(200);
});
