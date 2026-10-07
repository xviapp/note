import { beforeEach, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';
import { createJournalRecorder } from './journal-record';

vi.mock('./api', async (original) => {
  const actual = await original<typeof import('./api')>();
  return { ...actual, api: vi.fn(), unlockNote: vi.fn(), lockNote: vi.fn() };
});
beforeEach(() => vi.mocked(api).mockReset());

it('does not create a note before a nonempty first record is submitted', async () => {
  const record = createJournalRecorder('journal', '2026-10-07', '# 今天\n');
  expect(api).not.toHaveBeenCalled();
  await expect(record('', '  ', 'operation')).rejects.toThrow('请先输入内容');
  expect(api).not.toHaveBeenCalled();
  vi.mocked(api).mockResolvedValue({ node: { id: 'entry' }, created: true });
  await record('晚上', '散步', 'operation');
  expect(api).toHaveBeenCalledExactlyOnceWith('/api/nodes/journal/journal/entries', 'POST', {
    date: '2026-10-07', content: expect.stringMatching(/^# 今天\n\n### \d{2}:\d{2} · 晚上\n\n散步\n$/),
  }, 'operation');
});

it('reuses the persisted creation key after a lost response and reopening', async () => {
  vi.mocked(api).mockRejectedValueOnce(new ApiError('连接中断', 0))
    .mockResolvedValueOnce({ node: { id: 'entry' }, created: true });
  await expect(createJournalRecorder('journal', '2026-10-07', '# 今天')('', '记录', 'saved-key')).rejects.toThrow('连接中断');
  await createJournalRecorder('journal', '2026-10-07', '# 今天')('', '记录', 'saved-key');
  expect(vi.mocked(api).mock.calls[1]).toEqual(vi.mocked(api).mock.calls[0]);
});

it('appends to a concurrently created entry and preserves the retry key and body', async () => {
  const result = { node: { id: 'entry' }, created: false };
  vi.mocked(api).mockResolvedValueOnce(result)
    .mockResolvedValueOnce({ id: 'entry', kind: 'markdown', content: '其他设备的内容', revision: 2, attachments: [] })
    .mockRejectedValueOnce(new ApiError('连接中断', 0))
    .mockResolvedValueOnce(result).mockResolvedValueOnce({});
  const record = createJournalRecorder('journal', '2026-10-07', '# 模板');
  await expect(record('晚上', '我的记录', 'saved-key')).rejects.toThrow('连接中断');
  await record('晚上', '我的记录', 'saved-key');
  expect(vi.mocked(api).mock.calls[2]).toEqual([
    '/api/nodes/entry/content', 'PUT',
    { content: expect.stringMatching(/^其他设备的内容\n\n### \d{2}:\d{2} · 晚上\n\n我的记录\n$/), revision: 2, attachments: [] }, 'saved-key-append',
  ]);
  expect(vi.mocked(api).mock.calls[4]).toEqual(vi.mocked(api).mock.calls[2]);
});
