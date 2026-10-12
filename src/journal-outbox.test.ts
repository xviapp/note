import { beforeEach, expect, it, vi } from 'vitest';
import {
  clearJournalOutbox,
  flushJournalOutbox,
  loadOutboxDraft,
  queueOutboxRecord,
  queuedOutbox,
  saveOutboxDraft,
} from './journal-outbox';

const { unlocked, upload, record } = vi.hoisted(() => ({
  unlocked: new Set<string>(),
  upload: vi.fn(),
  record: vi.fn(),
}));
vi.mock('./keyring', () => ({ isUnlocked: (id: string) => unlocked.has(id) }));
vi.mock('./api', async (original) => ({ ...await original<typeof import('./api')>(), upload }));
vi.mock('./journal-record', () => ({ createJournalRecorder: (journal: string, date: string) =>
  (...args: unknown[]) => record(journal, date, ...args) }));

beforeEach(async () => {
  unlocked.clear();
  upload.mockReset();
  record.mockReset().mockResolvedValue({ created: true });
  await clearJournalOutbox();
});

const entry = (photos: File[] = []) => ({
  journalId: 'j1', keyId: 'k1', date: '2026-10-12', title: '午后', text: '雨停了。', operationKey: 'op-1', photos,
});

it('keeps a record for a locked journal and adds it to its day once unlocked', async () => {
  const photo = new File(['png-bytes'], '窗外.png', { type: 'image/png' });
  await queueOutboxRecord(entry([photo]));
  expect(await flushJournalOutbox()).toBe(0);
  expect(await queuedOutbox('j1')).toHaveLength(1);
  unlocked.add('k1');
  upload.mockResolvedValue({ id: 'f1', name: '窗外.png', mime: 'image/png', size: 9 });
  expect(await flushJournalOutbox()).toBe(1);
  const sent = upload.mock.calls[0]![0] as File;
  expect(sent.name).toBe('窗外.png');
  expect(await sent.text()).toBe('png-bytes');
  expect(upload.mock.calls[0]![1]).toBe('j1');
  expect(record).toHaveBeenCalledWith('j1', '2026-10-12', '午后', '雨停了。\n\n![窗外.png](/api/files/f1)', 'op-1', ['f1']);
  expect(await queuedOutbox()).toEqual([]);
  expect(await flushJournalOutbox()).toBe(0);
});

it('keeps a refused record with its reason and the unsaved input as a draft', async () => {
  unlocked.add('k1');
  record.mockRejectedValueOnce(new Error('这个目录不是日记本。'));
  await queueOutboxRecord(entry());
  expect(await flushJournalOutbox()).toBe(0);
  expect(await queuedOutbox('j1')).toEqual([expect.objectContaining({ error: '这个目录不是日记本。' })]);
  await saveOutboxDraft({ ...entry(), title: '还没写完' });
  expect(await loadOutboxDraft('j1', '2026-10-12')).toMatchObject({ title: '还没写完', text: '雨停了。' });
  await saveOutboxDraft({ ...entry(), title: '', text: '' });
  expect(await loadOutboxDraft('j1', '2026-10-12')).toBeNull();
});

it('stores nothing readable on the device', async () => {
  await queueOutboxRecord(entry());
  const rows = await new Promise<unknown[]>((resolve) => {
    const request = indexedDB.open('yejian-journal-outbox', 1);
    request.onsuccess = () => {
      const get = request.result.transaction('records').objectStore('records').getAll();
      get.onsuccess = () => resolve(get.result);
    };
  });
  const bytes = new Uint8Array((rows[0] as { sealed: ArrayBuffer }).sealed);
  expect(new TextDecoder().decode(bytes)).not.toContain('雨停了');
});
