import { beforeEach, expect, it, vi } from 'vitest';
import { setOffline } from './connectivity';
import { flushQuickRecords, queuedQuickRecords } from './quick-journal';
import { photoDraftId, photoQuality, queuePhoto, setPhotoQuality, shrinkPhoto } from './quick-photo';
import { localDate } from '../shared/journals';

const { upload, record, outbox, unlocked } = vi.hoisted(() => ({
  upload: vi.fn(), record: vi.fn(), outbox: vi.fn(), unlocked: new Set<string>(),
}));
vi.mock('./keyring', () => ({
  isUnlocked: (id: string) => unlocked.has(id),
  unlockedKey: async () => null,
}));
vi.mock('./api', async (original) => ({ ...await original<typeof import('./api')>(), upload }));
vi.mock('./journal-record', () => ({ createJournalRecorder: (journal: string, date: string) =>
  (...args: unknown[]) => record(journal, date, ...args) }));
vi.mock('./journal-outbox', () => ({ queueOutboxRecord: outbox }));

const PHOTO = '6f1c2a4e-1111-4222-8333-944455556666';
const photo = () => new File(['jpeg'], '随手拍.jpg', { type: 'image/jpeg' });

beforeEach(() => {
  localStorage.clear();
  unlocked.clear();
  setOffline(false);
  upload.mockReset().mockResolvedValue({ id: 'f1', name: '随手拍.jpg', mime: 'image/jpeg', size: 4 });
  record.mockReset().mockResolvedValue({ created: true });
  outbox.mockReset().mockResolvedValue(undefined);
});

it("queues a photo as today's record of its own, sent even by a flush of earlier days", async () => {
  const today = localDate();
  expect(await queuePhoto({ id: 'j1' }, today, PHOTO, photo())).toEqual({ locked: false, draftId: photoDraftId('j1', today, PHOTO) });
  expect(await queuedQuickRecords()).toEqual([expect.objectContaining({ date: today, photos: 1, camera: true, text: '' })]);
  expect(await flushQuickRecords({ earlier: true })).toBe(1);
  // The photo's ID is the operation, so a resend never adds it twice.
  expect(record).toHaveBeenCalledWith('j1', today, '', '![随手拍.jpg](/api/files/f1)', PHOTO, ['f1']);
  expect(await queuedQuickRecords()).toEqual([]);
});

it('queues the same photo once', async () => {
  await queuePhoto({ id: 'j1' }, '2026-11-18', PHOTO, photo());
  await queuePhoto({ id: 'j1' }, '2026-11-18', PHOTO, photo());
  expect(await queuedQuickRecords()).toHaveLength(1);
});

it('keeps a photo offline until a flush can send it', async () => {
  setOffline(true);
  await queuePhoto({ id: 'j1' }, '2026-11-18', PHOTO, photo());
  expect(await flushQuickRecords()).toBe(0);
  setOffline(false);
  expect(await flushQuickRecords()).toBe(1);
});

it('leaves a photo for a locked journal in the device outbox', async () => {
  expect(await queuePhoto({ id: 'j1', key_id: 'k1' }, '2026-11-18', PHOTO, photo())).toEqual({ locked: true });
  expect(outbox).toHaveBeenCalledWith(expect.objectContaining({
    journalId: 'j1', keyId: 'k1', date: '2026-11-18', text: '', operationKey: PHOTO, photos: [expect.any(File)],
  }));
  expect(await queuedQuickRecords()).toEqual([]);
});

it('keeps the chosen quality on this device, the original as it was taken', async () => {
  expect(photoQuality()).toBe('standard');
  setPhotoQuality('original');
  expect(photoQuality()).toBe('original');
  const kept = await shrinkPhoto(new Blob(['exif and pixels'], { type: 'image/jpeg' }), '随手拍.jpg', 5);
  expect([kept.name, kept.type, kept.lastModified, await kept.text()]).toEqual(['随手拍.jpg', 'image/jpeg', 5, 'exif and pixels']);
  setPhotoQuality('standard');
  expect(localStorage.getItem('note:photo-quality')).toBeNull();
});
