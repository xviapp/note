import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteDetail } from '../shared/types';
import { appendContent, createNoteAppender } from './append-note';
import { api, ApiError, lockNote, unlockNote } from './api';

vi.mock('./api', async (original) => {
  const actual = await original<typeof import('./api')>();
  return { ...actual, api: vi.fn(), lockNote: vi.fn(), unlockNote: vi.fn() };
});
const source = { id: 'day', kind: 'markdown', content: '# 今天\n\n原文', revision: 3,
  attachments: [{ id: 'image' }] } as NoteDetail;

describe('quick append', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(api).mockReset(); });
  it('adds an optional heading without changing the original text', () => {
    expect(appendContent('原文\n', ' 晚上 ', ' 散步\n回家 ')).toBe('原文\n\n## 晚上\n\n散步\n回家\n');
    expect(appendContent('', '', '内容')).toBe('内容\n');
    expect(appendContent('原文\n\n', '标题', '内容', false)).toBe('原文\n\n标题\n\n内容\n');
  });
  it('reads the latest body and keeps its attachments and revision', async () => {
    vi.mocked(api).mockResolvedValueOnce(source).mockResolvedValueOnce({});
    await createNoteAppender('day')('晚上', '散步');
    expect(api).toHaveBeenLastCalledWith('/api/nodes/day/content', 'PUT', {
      content: '# 今天\n\n原文\n\n## 晚上\n\n散步\n', attachments: ['image'], revision: 3,
    }, expect.any(String));
    expect(unlockNote).toHaveBeenCalledWith('day');
    expect(lockNote).toHaveBeenCalledWith('day');
  });
  it('adds a submission timestamp for project records', async () => {
    vi.mocked(api).mockResolvedValueOnce(source).mockResolvedValueOnce({});
    await createNoteAppender('day', true)('进展', '完成第一步');
    const payload = vi.mocked(api).mock.calls[1][2] as { content: string };
    expect(payload.content).toMatch(/## 进展\n\n> \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}\n\n完成第一步\n$/);
  });
  it('retries an uncertain write with the same payload and idempotency key', async () => {
    vi.mocked(api).mockResolvedValueOnce(source).mockRejectedValueOnce(new ApiError('连接中断', 0)).mockResolvedValueOnce({});
    const append = createNoteAppender('day');
    await expect(append('', '内容')).rejects.toThrow('连接中断');
    const first = vi.mocked(api).mock.calls[1];
    await append('', '内容');
    expect(vi.mocked(api).mock.calls[2]).toEqual(first);
    expect(api).toHaveBeenCalledTimes(3);
  });
  it('after a conflict, appends against the fresh body on explicit retry', async () => {
    vi.mocked(api).mockResolvedValueOnce(source).mockRejectedValueOnce(new ApiError('冲突', 409, 'VERSION_CONFLICT'))
      .mockResolvedValueOnce({ ...source, content: '其他页面更新', revision: 4 }).mockResolvedValueOnce({});
    const append = createNoteAppender('day');
    await expect(append('', '内容')).rejects.toThrow('正文已在其他页面更新');
    await append('', '内容');
    expect(api).toHaveBeenLastCalledWith('/api/nodes/day/content', 'PUT', {
      content: '其他页面更新\n\n内容\n', attachments: ['image'], revision: 4,
    }, expect.any(String));
  });
  it('rejects empty, locked and non-text notes without writing', async () => {
    const append = createNoteAppender('day');
    await expect(append('', '  ')).rejects.toThrow('请先输入');
    expect(api).not.toHaveBeenCalled();
    vi.mocked(api).mockResolvedValueOnce({ ...source, locked: 'key' });
    await expect(append('', '内容')).rejects.toThrow('解锁');
    vi.mocked(api).mockResolvedValueOnce({ ...source, kind: 'pdf' });
    await expect(append('', '内容')).rejects.toThrow('文本笔记');
    expect(unlockNote).not.toHaveBeenCalled();
  });
});
