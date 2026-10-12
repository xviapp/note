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
  expect(await readDraft('n1')).toBeNull();
  expect((saved.mock.calls[0]![0] as CustomEvent<NoteDetail>).detail.revision).toBe(4);
});

it('waits after a lost connection and resends with the same operation', async () => {
  api.mockRejectedValue(new ApiError('连接已中断', 0));
  await queueSave(note, '新正文', []);
  await flushSaves();
  expect(pendingSave('n1')).toMatchObject({ id: 'n1' });
  expect(pendingSave('n1')!.error).toBeUndefined();
  const key = api.mock.calls[0]![3];
  api.mockImplementation(async (_path: string, method = 'GET') =>
    method === 'PUT' ? { id: 'n1', revision: 4 } : { ...note, revision: 4 });
  await flushSaves();
  expect(api.mock.calls.find((call) => call[1] === 'PUT' && call !== api.mock.calls[0])![3]).toBe(key);
  expect(pendingSave('n1')).toBeUndefined();
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
