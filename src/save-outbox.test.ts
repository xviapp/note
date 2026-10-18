import { readSentHistory } from './sent-history';
import { beforeEach, expect, it, vi } from 'vitest';
import type { NoteDetail } from '../shared/types';
import { readDraft } from './note-drafts';
import { discardSave, flushSaves, pendingSave, queueSave, type SaveFailure } from './save-outbox';

const { api, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(message: string, public status: number, public code?: string) {
      super(message);
    }
  }
  return { api: vi.fn(), ApiError };
});
vi.mock('./api', () => ({
  api,
  ApiError,
  unlockNote: vi.fn(async () => {}),
  lockNote: vi.fn(),
  uncertainFailure: (error: unknown) => error instanceof ApiError && (error.status === 0 || error.status >= 500),
}));

const note = { id: 'n1', title: '读书笔记', revision: 3, key_id: null, content: '旧正文', attachments: [] } as unknown as NoteDetail;
beforeEach(async () => {
  api.mockReset();
  await discardSave('n1');
  localStorage.clear();
});

it('sends the body in the background and clears the draft once saved', async () => {
  const saved = vi.fn();
  window.addEventListener('note:saved', saved, { once: true });
  api.mockImplementation(async (path: string, method = 'GET') =>
    method === 'PUT' ? { id: 'n1', revision: 4 } : { ...note, revision: 4, content: '新正文' });
  await queueSave(note, '新正文', []);
  await flushSaves();
  expect(api).toHaveBeenCalledWith('/api/nodes/n1/content', 'PUT', { content: '新正文', attachments: [], revision: 3 }, expect.any(String));
  expect(pendingSave('n1')).toBeUndefined();
  expect(readSentHistory()).toEqual([expect.objectContaining({ summary: '读书笔记', detail: '笔记修改' })]);
  expect(await readDraft('n1')).toBeNull();
  expect((saved.mock.calls[0]![0] as CustomEvent<NoteDetail>).detail.revision).toBe(4);
});

it('waits after a lost connection and resends with the same operation', async () => {
  api.mockRejectedValue(new ApiError('连接已中断', 0));
  await queueSave(note, '新正文', []);
  await flushSaves();
  expect(readSentHistory()).toEqual([]);
  expect(pendingSave('n1')).toMatchObject({ id: 'n1' });
  expect(pendingSave('n1')!.error).toBeUndefined();
  const key = api.mock.calls[0]![3];
  api.mockImplementation(async (_path: string, method = 'GET') =>
    method === 'PUT' ? { id: 'n1', revision: 4 } : { ...note, revision: 4 });
  await flushSaves();
  expect(api.mock.calls.find((call) => call[1] === 'PUT' && call !== api.mock.calls[0])![3]).toBe(key);
  expect(pendingSave('n1')).toBeUndefined();
});

it('sends a later edit from another window as its own operation', async () => {
  api.mockRejectedValue(new ApiError('连接已中断', 0));
  await queueSave(note, '正文 A', []);
  await flushSaves();
  const first = api.mock.calls[0]![3];
  // Another window keeps editing the note; its draft replaces A's.
  await new Promise((resolve) => setTimeout(resolve, 2));
  localStorage.setItem('note-draft:n1', JSON.stringify({ content: '正文 B', attachments: [], revision: 4, savedAt: Date.now() }));
  api.mockReset();
  api.mockRejectedValue(new ApiError('这篇笔记已在其他页面更新，当前编辑内容已保留。', 409, 'VERSION_CONFLICT'));
  await flushSaves();
  const [, , body, key] = api.mock.calls.find((call) => call[1] === 'PUT')!;
  expect(body).toEqual({ content: '正文 B', attachments: [], revision: 4 });
  expect(key).not.toBe(first);
  // Refused, B waits with its draft instead of being cleared as saved.
  expect(pendingSave('n1')!.error).toContain('已在其他页面更新');
  expect((await readDraft('n1'))!.content).toBe('正文 B');
});

it('hands a refused save to the open note, or keeps it with its draft and reason', async () => {
  api.mockRejectedValue(new ApiError('这篇笔记已在其他页面更新，当前编辑内容已保留。', 409, 'VERSION_CONFLICT'));
  await queueSave(note, '设备二的草稿', []);
  await flushSaves();
  expect(pendingSave('n1')!.error).toContain('已在其他页面更新');
  expect((await readDraft('n1'))!.content).toBe('设备二的草稿');
  // An open note takes it back into its editor.
  const take = (event: Event) => ((event as CustomEvent<SaveFailure>).detail.handled = true);
  window.addEventListener('note:save-failed', take);
  await queueSave(note, '设备二的草稿', []);
  await flushSaves();
  window.removeEventListener('note:save-failed', take);
  expect(pendingSave('n1')).toBeUndefined();
  expect((await readDraft('n1'))!.content).toBe('设备二的草稿');
});

it('refuses to queue a save whose body cannot be kept on this device', async () => {
  const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new DOMException('full', 'QuotaExceededError');
  });
  try {
    await expect(queueSave(note, '新正文', [])).rejects.toThrow('无法在本机暂存正文');
  } finally {
    setItem.mockRestore();
  }
  expect(pendingSave('n1')).toBeUndefined();
  expect(api).not.toHaveBeenCalled();
});

it('never sends an older draft, and keeps the entry when its body is gone', async () => {
  api.mockRejectedValue(new ApiError('连接已中断', 0));
  await queueSave(note, '新正文', []);
  await flushSaves();
  // Something replaced the draft with an older one, then removed it.
  localStorage.setItem('note-draft:n1', JSON.stringify({ content: '旧草稿', attachments: [], revision: 3, savedAt: 1 }));
  api.mockReset();
  await flushSaves();
  expect(api).not.toHaveBeenCalled();
  expect(pendingSave('n1')!.error).toContain('找不到这次保存的正文');
  localStorage.removeItem('note-draft:n1');
  await flushSaves(true);
  expect(api).not.toHaveBeenCalled();
  expect(pendingSave('n1')).toMatchObject({ id: 'n1', error: expect.stringContaining('找不到') });
});

it('still sends an entry queued before drafts were stamped with it', async () => {
  // 0.4.24 stamped the draft and the entry separately, the entry a little later.
  localStorage.setItem('note-draft:n1', JSON.stringify({ content: '旧版的正文', attachments: [], revision: 3, savedAt: 1000 }));
  localStorage.setItem('note-draft:saves', JSON.stringify([{ id: 'n1', title: '读书笔记', keyId: null, revision: 3, key: 'op-old', savedAt: 1003 }]));
  window.dispatchEvent(new StorageEvent('storage', { key: 'note-draft:saves' }));
  api.mockImplementation(async (_path: string, method = 'GET') =>
    method === 'PUT' ? { id: 'n1', revision: 4 } : { ...note, revision: 4 });
  await flushSaves();
  expect(api).toHaveBeenCalledWith('/api/nodes/n1/content', 'PUT', { content: '旧版的正文', attachments: [], revision: 3 }, 'op-old');
  expect(pendingSave('n1')).toBeUndefined();
});
