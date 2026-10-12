import { beforeEach, expect, it, vi } from 'vitest';
import { readDraft, writeDraft } from './note-drafts';
import { keepPhoto, pendingPhotos } from './pending-photos';
import { setOffline } from './connectivity';
import { discardQuickRecord, flushQuickRecords, markQuickRecord, queuedQuickRecords } from './quick-journal';
import { localDate } from '../shared/journals';

const { upload, record, unlocked } = vi.hoisted(() => ({ upload: vi.fn(), record: vi.fn(), unlocked: new Map<string, CryptoKey>() }));
vi.mock('./keyring', () => ({
  isUnlocked: (id: string) => unlocked.has(id),
  unlockedKey: async (id: string) => unlocked.get(id) ?? null,
}));
vi.mock('./api', async (original) => ({ ...await original<typeof import('./api')>(), upload }));
vi.mock('./journal-record', () => ({ createJournalRecorder: (journal: string, date: string) =>
  (...args: unknown[]) => record(journal, date, ...args) }));

// A record as QuickAppend keeps it once 保存 is pressed.
const saveRecord = (date: string, saved: Record<string, unknown> = {}, keyId?: string) =>
  writeDraft(`append:journal:j1:${date}`, {
    content: JSON.stringify({ title: '夜里', text: '下雨了。', attachments: [], operationKey: `op-${date}`, retrying: true, queued: true, ...saved }),
    attachments: [], revision: 0, savedAt: Date.now(),
  }, keyId);

beforeEach(() => {
  localStorage.clear();
  unlocked.clear();
  setOffline(false);
  upload.mockReset();
  record.mockReset().mockResolvedValue({ created: true });
});

it('sends a record saved on an earlier day to that day, photos included', async () => {
  await saveRecord('2026-10-12');
  await keepPhoto('append:journal:j1:2026-10-12', 'p1', new File(['png'], '雨.png', { type: 'image/png' }));
  upload.mockResolvedValue({ id: 'f1', name: '雨.png', mime: 'image/png', size: 3 });
  expect(await queuedQuickRecords()).toEqual([expect.objectContaining({ journalId: 'j1', date: '2026-10-12', photos: 1 })]);
  expect(await flushQuickRecords({ earlier: true })).toBe(1);
  expect(record).toHaveBeenCalledWith('j1', '2026-10-12', '夜里', '下雨了。\n\n![雨.png](/api/files/f1)', 'op-2026-10-12', ['f1']);
  expect(await readDraft('append:journal:j1:2026-10-12')).toBeNull();
  expect(await pendingPhotos('append:journal:j1:2026-10-12')).toEqual([]);
  expect(await queuedQuickRecords()).toEqual([]);
});

it("leaves today's record and unsaved input to the window", async () => {
  await saveRecord(localDate());
  await saveRecord('2026-10-11', { queued: false, retrying: false });
  expect(await flushQuickRecords({ earlier: true })).toBe(0);
  expect(record).not.toHaveBeenCalled();
  expect((await queuedQuickRecords()).map((item) => item.date)).toEqual([localDate()]);
  // 待发送 sends every saved one.
  expect(await flushQuickRecords()).toBe(1);
});

it('keeps a refused record with its reason until it is removed', async () => {
  await saveRecord('2026-10-12');
  record.mockRejectedValueOnce(new Error('这个目录不是日记本。'));
  expect(await flushQuickRecords()).toBe(0);
  expect(await queuedQuickRecords()).toEqual([expect.objectContaining({ error: '这个目录不是日记本。' })]);
  await discardQuickRecord('append:journal:j1:2026-10-12');
  expect(await queuedQuickRecords()).toEqual([]);
});

it('sends nothing offline and everything once back online', async () => {
  await saveRecord('2026-10-12');
  setOffline(true);
  expect(await flushQuickRecords({ earlier: true })).toBe(0);
  expect(await flushQuickRecords()).toBe(0);
  setOffline(false);
  expect(await flushQuickRecords()).toBe(1);
  expect(record).toHaveBeenCalledTimes(1);
});

it('lists a record of a locked journal as waiting, without sending or reading it', async () => {
  const keyId = '0a1b2c3d-0000-4000-8000-000000000001';
  unlocked.set(keyId, await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
  markQuickRecord('append:journal:j1:2026-10-12', keyId);
  await saveRecord('2026-10-12', {}, keyId);
  unlocked.delete(keyId);
  expect(await queuedQuickRecords()).toEqual([expect.objectContaining({ date: '2026-10-12', locked: keyId, text: '' })]);
  expect(await flushQuickRecords()).toBe(0);
  expect(record).not.toHaveBeenCalled();
  await discardQuickRecord('append:journal:j1:2026-10-12');
  expect(await queuedQuickRecords()).toEqual([]);
  expect(localStorage.getItem('note-draft:quick-records')).toBeNull();
});
