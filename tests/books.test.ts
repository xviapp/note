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
import type { BookInfo, BookPages, FileInfo, NoteDetail, NoteNode } from '../shared/types';
import { sseData } from '../shared/sse';
import { validateBackup, type LibraryBackup } from '../shared/backup';

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]);
let cookie = '';
let contexts: ExecutionContext[] = [];
beforeAll(() => applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS));
async function request(path: string, method = 'GET', data?: unknown, key?: string) {
  const context = createExecutionContext();
  contexts.push(context);
  return worker.fetch(
    new Request(`https://notes.test${path}`, {
      method,
      headers: {
        origin: 'https://notes.test',
        'content-type': 'application/json',
        cookie,
        ...(key ? { 'x-idempotency-key': key } : {}),
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
  key?: string,
): Promise<T> {
  const response = await request(path, method, data, key);
  expect(response.ok, await response.clone().text()).toBe(true);
  return response.json() as Promise<T>;
}
async function photo(): Promise<FileInfo> {
  const context = createExecutionContext();
  contexts.push(context);
  const response = await worker.fetch(
    new Request(`https://notes.test/api/files?name=page.jpg&size=${jpeg.length}`, {
      method: 'POST',
      headers: { origin: 'https://notes.test', cookie },
      body: jpeg,
    }),
    bindings,
    context,
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json() as Promise<FileInfo>;
}
function provider(content: string) {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
async function newBook(title = '人类简史') {
  return ok<NoteNode>('/api/nodes', 'POST', {
    kind: 'folder',
    title,
    book: { author: '赫拉利', pageCount: 400, rolePrompt: '你是一位耐心的历史老师。' },
  });
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
    bindings.DB.prepare('DELETE FROM ai_settings'),
    bindings.DB.prepare(
      'UPDATE site SET password_hash=NULL,password_salt=NULL,auth_epoch=0,quota_bytes=8000000000,allocated_bytes=0 WHERE id=1',
    ),
  ]);
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

describe('books', () => {
  it('creates a book that its notes report, and edits only books', async () => {
    const book = await newBook();
    expect(book.is_book).toBe(1);
    const page = await ok<NoteNode>('/api/nodes', 'POST', {
      kind: 'markdown',
      title: '摘录',
      parentId: book.id,
      content: '正文',
    });
    const detail = await ok<NoteDetail>(`/api/nodes/${page.id}`);
    expect(detail.book).toMatchObject({ id: book.id, title: '人类简史', author: '赫拉利' });
    expect((await ok<NoteDetail>(`/api/nodes/${book.id}`)).is_book).toBe(1);
    expect((await request(`/api/nodes/${page.id}/book`, 'PUT', { author: 'x' })).status).toBe(404);
    expect((await request(`/api/nodes/${book.id}/book`, 'PUT', { pagesRead: 401 })).status).toBe(
      400,
    );
    expect(
      (await ok<BookInfo>(`/api/nodes/${book.id}/book`, 'PUT', { status: 'finished' })).status,
    ).toBe('finished');
    const folder = await ok<NoteNode>('/api/nodes', 'POST', { kind: 'folder', title: '杂项' });
    expect((await request(`/api/nodes/${folder.id}/book`, 'PUT', {})).status).toBe(404);
    expect(
      (await request('/api/nodes', 'POST', { kind: 'markdown', title: 'x', book: {} })).status,
    ).toBe(400);
    expect(
      (
        await request('/api/nodes', 'POST', {
          kind: 'folder',
          book: { pagesRead: 5, pageCount: 2 },
        })
      ).status,
    ).toBe(400);
    expect((await ok<NoteNode>('/api/nodes', 'POST', { kind: 'folder', book: {} })).title).toBe(
      '未命名书籍',
    );
  });

  it('recognizes a photographed page once and records reading progress', async () => {
    const book = await newBook(),
      file = await photo();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => provider('认知革命发生在大约七万年前。'));
    const page = await ok<NoteNode>(
      `/api/nodes/${book.id}/pages`,
      'POST',
      { fileId: file.id, page: 12 },
      'page-12',
    );
    expect(page).toMatchObject({ title: '第 12 页', parent_id: book.id, kind: 'markdown' });
    const sent = JSON.parse(String(fetch.mock.calls[0][1]!.body));
    expect(sent.messages[1].content[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    const detail = await ok<NoteDetail>(`/api/nodes/${page.id}`);
    expect(detail.content).toBe(
      `![第 12 页](/api/files/${file.id})\n\n认知革命发生在大约七万年前。\n`,
    );
    expect(detail.attachments.map((x) => x.id)).toEqual([file.id]);
    expect(detail.book!.pages_read).toBe(12);
    // A repeated request is not recognized (or paid for) again.
    await ok(`/api/nodes/${book.id}/pages`, 'POST', { fileId: file.id, page: 12 }, 'page-12');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses pages outside a book and keeps nothing when nothing is recognized', async () => {
    const folder = await ok<NoteNode>('/api/nodes', 'POST', { kind: 'folder', title: '杂项' });
    const file = await photo();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => provider('  '));
    expect(
      (await request(`/api/nodes/${folder.id}/pages`, 'POST', { fileId: file.id })).status,
    ).toBe(404);
    const book = await newBook();
    const response = await request(`/api/nodes/${book.id}/pages`, 'POST', { fileId: file.id });
    expect(response.status).toBe(422);
    expect((await ok<{ nodes: NoteNode[] }>(`/api/nodes?parent=${book.id}`)).nodes).toEqual([]);
  });

  it('gives discussions the book role and the page they discuss', async () => {
    const book = await newBook(),
      file = await photo();
    const page = await ok<NoteNode>('/api/nodes', 'POST', {
      kind: 'markdown',
      title: '第 3 页',
      parentId: book.id,
      content: `![第 3 页](/api/files/${file.id})\n\n农业革命是史上最大的骗局。`,
    });
    const discussion = await ok<NoteNode>('/api/nodes', 'POST', {
      kind: 'markdown',
      title: '讨论',
      parentId: page.id,
      content: '',
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => provider('回答'));
    const response = await request(`/api/nodes/${discussion.id}/assistant`, 'POST', {
      content: '为什么这么说？',
    });
    for await (const _ of sseData(response.body!)) void _;
    const system = JSON.parse(String(fetch.mock.calls[0][1]!.body)).messages[0].content as string;
    expect(system).toContain('《人类简史》，作者 赫拉利');
    expect(system).toContain('你是一位耐心的历史老师。');
    expect(system).toContain('农业革命是史上最大的骗局。');
    expect(system).not.toContain(file.id);
  });

  it('keeps book details in backups', async () => {
    const book = await newBook();
    const exported = await ok<{ id: string; archive: LibraryBackup }>('/api/backups', 'POST');
    expect(exported.archive.tables.books).toEqual([
      expect.objectContaining({ node_id: book.id, author: '赫拉利', page_count: 400 }),
    ]);
    const older = structuredClone(exported.archive) as Partial<LibraryBackup>;
    delete (older.tables as Partial<LibraryBackup['tables']>).books;
    expect(validateBackup(older).tables.books).toEqual([]);
    const broken = structuredClone(exported.archive);
    broken.tables.books[0].status = 'lost';
    expect(() => validateBackup(broken)).toThrow('书籍信息不正确');
  });

  it('pages carry a summary and questions, and hidden discussions summarized into a reading note', async () => {
    const book = await newBook(),
      first = await photo(),
      second = await photo();
    const replies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => provider(replies.shift()!));
    replies.push('农业革命让食物增多，却让多数人更辛苦。', '小麦驯化了人类。');
    const page12 = await ok<NoteNode>(
      `/api/nodes/${book.id}/pages`,
      'POST',
      { fileId: first.id, page: 12 },
      'p12',
    );
    const page11 = await ok<NoteNode>(
      `/api/nodes/${book.id}/pages`,
      'POST',
      { fileId: second.id, page: 11 },
      'p11',
    );
    // Pages list in page order, with neighbours for turning pages.
    const list = await ok<BookPages>(`/api/nodes/${book.id}/pages`);
    expect(list.pages.map((item) => item.page)).toEqual([11, 12]);
    let detail = await ok<NoteDetail>(`/api/nodes/${page12.id}`);
    expect(detail.book_page).toMatchObject({ page: 12, prev: page11.id, next: null, stale: true });

    replies.push(
      JSON.stringify({
        summary: '作者质疑农业带来更好生活。',
        questions: ['为什么说是骗局？', '证据是什么？'],
      }),
    );
    const insights = await ok<NoteDetail['book_page']>(`/api/nodes/${page12.id}/insights`, 'POST');
    expect(insights).toMatchObject({
      summary: '作者质疑农业带来更好生活。',
      questions: ['为什么说是骗局？', '证据是什么？'],
      stale: false,
    });

    // A discussion is a hidden note below the page; the page lists it.
    const discussion = await ok<NoteNode>(`/api/nodes/${page12.id}/discussions`, 'POST', {
      title: '为什么说是骗局？',
    });
    expect((await ok<{ nodes: NoteNode[] }>(`/api/nodes?parent=${page12.id}`)).nodes).toEqual([]);
    expect((await ok<NoteDetail>(`/api/nodes/${page12.id}`)).child_count).toBe(0);
    expect((await ok<NoteDetail>(`/api/nodes/${discussion.id}`)).discussion_page).toBe(page12.id);
    expect((await request(`/api/nodes/${discussion.id}/organize`, 'POST', {})).status).toBe(400);
    const fetch = vi.mocked(globalThis.fetch);
    replies.push('先回答：个体生活变差了。');
    const chat = await request(`/api/nodes/${discussion.id}/assistant`, 'POST', {
      content: '为什么说是骗局？',
    });
    for await (const _ of sseData(chat.body!)) void _;
    const system = JSON.parse(String(fetch.mock.calls.at(-1)![1]!.body)).messages[0].content;
    expect(system).toContain('作者质疑农业带来更好生活。');
    expect(system).toContain('先回应问题，再说明依据');
    detail = await ok<NoteDetail>(`/api/nodes/${page12.id}`);
    expect(detail.book_page!.discussions).toEqual([
      { id: discussion.id, title: '为什么说是骗局？', replies: 1, noted: false },
    ]);

    const section = (conclusion: string) =>
      JSON.stringify({ conclusion, basis: '第 12 页', other: '暂无', next: '证据是什么？' });
    replies.push(section('多数人更辛苦。'));
    const organized = await ok<{ note: NoteNode; updated: boolean }>(
      `/api/nodes/${discussion.id}/organize`,
      'POST',
      {},
    );
    expect(organized.updated).toBe(false);
    expect(organized.note).toMatchObject({ title: '第 12 页 · 读书笔记', parent_id: page12.id });
    replies.push(section('剩余变成了人口和特权。'));
    const again = await ok<{ note: NoteNode; updated: boolean }>(
      `/api/nodes/${discussion.id}/organize`,
      'POST',
      {},
    );
    expect(again).toMatchObject({ updated: true, note: { id: organized.note.id } });
    let note = await ok<NoteDetail>(`/api/nodes/${organized.note.id}`);
    expect(note.content.match(/<!-- discussion:/g)).toHaveLength(1);
    expect(note.content).toContain('剩余变成了人口和特权。');
    expect(note.content).not.toContain('多数人更辛苦。');

    // A section edited by hand is not replaced without asking.
    const token = (await ok<{ token: string }>('/api/edit/unlock', 'POST', { nodeId: note.id }))
      .token;
    const context = createExecutionContext();
    contexts.push(context);
    const edited = await worker.fetch(
      new Request(`https://notes.test/api/nodes/${note.id}/content`, {
        method: 'PUT',
        headers: {
          origin: 'https://notes.test',
          'content-type': 'application/json',
          cookie,
          'x-note-edit': token,
        },
        body: JSON.stringify({
          revision: note.revision,
          content: note.content.replace('剩余变成了人口和特权。', '我的看法。'),
          attachments: [],
        }),
      }),
      bindings,
      context,
    );
    expect(edited.ok, await edited.clone().text()).toBe(true);
    const calls = fetch.mock.calls.length;
    const refused = await request(`/api/nodes/${discussion.id}/organize`, 'POST', {});
    expect(refused.status).toBe(409);
    expect((await refused.json<{ code: string }>()).code).toBe('BOOK_SECTION_EDITED');
    expect(fetch.mock.calls.length).toBe(calls);
    replies.push(section('第三次。'));
    await ok(`/api/nodes/${discussion.id}/organize`, 'POST', { force: true });
    note = await ok<NoteDetail>(`/api/nodes/${organized.note.id}`);
    expect(note.content).toContain('第三次。');
    expect(note.content).not.toContain('我的看法。');

    // The book's reading note collects the pages' notes in page order.
    const collected = await ok<{ note: NoteNode; pages: number }>(
      `/api/nodes/${book.id}/book-note`,
      'POST',
    );
    expect(collected).toMatchObject({ pages: 1, note: { title: '《人类简史》读书笔记' } });
    const book2 = await ok<NoteDetail>(`/api/nodes/${collected.note.id}`);
    expect(book2.content).toContain('## 第 12 页');
    expect(book2.content).not.toContain('<!-- discussion:');
    const repeat = await ok<{ note: NoteNode }>(`/api/nodes/${book.id}/book-note`, 'POST');
    expect(repeat.note.id).toBe(collected.note.id);
    expect((await ok<BookPages>(`/api/nodes/${book.id}/pages`)).others.map((n) => n.id)).toEqual([
      collected.note.id,
    ]);

    // All of it is kept in backups.
    const exported = await ok<{ archive: LibraryBackup }>('/api/backups', 'POST');
    expect(exported.archive.tables.book_pages).toHaveLength(2);
    expect(exported.archive.tables.book_discussions).toEqual([
      expect.objectContaining({ node_id: discussion.id }),
    ]);
    expect(exported.archive.tables.book_note_sections).toEqual([
      expect.objectContaining({ discussion_id: discussion.id, note_id: organized.note.id }),
    ]);
    expect(validateBackup(structuredClone(exported.archive)).tables.book_pages).toHaveLength(2);
  });
});
