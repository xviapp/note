import { beforeEach, expect, it, vi } from 'vitest';
import { api, ApiError, lockNote, unlockNote } from './api';
import { createSectionWriter } from './edit-section';
import type { NoteDetail } from '../shared/types';

vi.mock('./api', async (original) => {
  const actual = await original<typeof import('./api')>();
  return { ...actual, api: vi.fn(), lockNote: vi.fn(), unlockNote: vi.fn() };
});
const note = { id: 'note', content: '前言\n\n## 一\n\n正文\n\n## 二\n\n保留', revision: 3,
  attachments: [{ id: 'photo' }], key_id: 'encrypted-key' } as NoteDetail;
const section = { start: note.content.indexOf('## 一'), end: note.content.indexOf('## 二'), title: '一', level: 2, children: 0 };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api).mockReset(); vi.mocked(unlockNote).mockReset(); });

it('saves only the chosen range through the regular encrypted API and keeps attachments', async () => {
  vi.mocked(api).mockResolvedValueOnce({ revision: 4, current_version_id: 'v4' })
    .mockResolvedValueOnce({ ...note, revision: 4, current_version_id: 'v4' });
  const result = await createSectionWriter(note, section)('## 改名\n\n新正文');
  expect(api).toHaveBeenCalledWith('/api/nodes/note/content', 'PUT', {
    content: '前言\n\n## 改名\n\n新正文\n\n## 二\n\n保留', revision: 3, attachments: ['photo'],
  }, expect.any(String));
  expect(result).toMatchObject({ revision: 4, current_version_id: 'v4', key_id: 'encrypted-key', attachments: note.attachments });
  expect(unlockNote).toHaveBeenCalledWith('note');
  expect(lockNote).toHaveBeenCalledWith('note');
});

it('retries an uncertain deletion with the exact same request and operation key', async () => {
  vi.mocked(api).mockRejectedValueOnce(new ApiError('超时', 0)).mockResolvedValueOnce({ revision: 4 })
    .mockResolvedValueOnce({ ...note, revision: 4 });
  const save = createSectionWriter(note, section);
  await expect(save('')).rejects.toThrow('超时');
  const first = vi.mocked(api).mock.calls[0];
  await save('不会改动未确认的请求');
  expect(vi.mocked(api).mock.calls[1]).toEqual(first);
  expect(first[2]).toMatchObject({ content: '前言\n\n## 二\n\n保留' });
});

it('does not silently advance a conflicting revision and releases edit tokens on failure', async () => {
  vi.mocked(api).mockRejectedValueOnce(new ApiError('冲突', 409, 'VERSION_CONFLICT'));
  await expect(createSectionWriter(note, section)('修改')).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  expect(api).toHaveBeenCalledTimes(1);
  expect(lockNote).toHaveBeenCalledWith('note');
});

it('does not write when unlocking fails', async () => {
  vi.mocked(unlockNote).mockRejectedValueOnce(new ApiError('已锁定', 403));
  await expect(createSectionWriter(note, section)('修改')).rejects.toThrow('已锁定');
  expect(api).not.toHaveBeenCalled();
  expect(lockNote).toHaveBeenCalledWith('note');
});

it('loads the authoritative body when an uncertain save was followed by another edit', async () => {
  const newer = { ...note, revision: 5, content: '其他页面在保存后又做了修改' };
  vi.mocked(api).mockRejectedValueOnce(new ApiError('超时', 0))
    .mockResolvedValueOnce({ revision: 5 }).mockResolvedValueOnce(newer);
  const save = createSectionWriter(note, section);
  await expect(save('本机的修改')).rejects.toThrow('超时');
  expect(await save('本机的修改')).toEqual(newer);
});

it('does not accept an offline cached body as confirmation of a newer saved revision', async () => {
  vi.mocked(api).mockResolvedValueOnce({ revision: 4 }).mockResolvedValueOnce(note)
    .mockResolvedValueOnce({ revision: 4 }).mockResolvedValueOnce({ ...note, revision: 4 });
  const save = createSectionWriter(note, section);
  await expect(save('修改')).rejects.toThrow('暂时无法确认最新版本');
  const first = vi.mocked(api).mock.calls[0];
  await save('修改');
  expect(vi.mocked(api).mock.calls[2]).toEqual(first);
});
