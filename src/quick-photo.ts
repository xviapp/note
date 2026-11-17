import { queueOutboxRecord } from './journal-outbox';
import { isUnlocked } from './keyring';
import { hasDraft, writeDraft } from './note-drafts';
import { dropPhotos, keepPhoto } from './pending-photos';
import { markQuickRecord } from './quick-journal';

// 随手拍: a camera photo becomes a record of its own in that day's journal
// entry, with no text. It is queued like a saved 今日记 (src/quick-journal.ts),
// or in the device outbox while an encrypted journal is locked here
// (src/journal-outbox.ts), so offline and locked work as they do there.
export interface PhotoJournal {
  id: string;
  key_id?: string | null;
}

export const photoDraftId = (journalId: string, date: string, photoId: string) =>
  `append:journal:${journalId}:${date}:photo:${photoId}`;

// How a camera photo is kept, a setting of this device. Shrunk ones are
// re-encoded as JPEG, which drops their metadata (location included); the
// original keeps it.
export type PhotoQuality = 'standard' | 'high' | 'original';
export const PHOTO_QUALITIES: { value: PhotoQuality; label: string }[] = [
  { value: 'standard', label: '标准（长边 2048 像素）' },
  { value: 'high', label: '高（长边 4096 像素）' },
  { value: 'original', label: '原图（保留位置等信息）' },
];
const SIZES = { standard: { edge: 2048, quality: 0.85 }, high: { edge: 4096, quality: 0.92 } };
const QUALITY_KEY = 'note:photo-quality';
export function photoQuality(): PhotoQuality {
  try {
    const value = localStorage.getItem(QUALITY_KEY);
    if (value === 'high' || value === 'original') return value;
  } catch {
    /* Unavailable storage: the default. */
  }
  return 'standard';
}
export function setPhotoQuality(value: PhotoQuality) {
  try {
    if (value === 'standard') localStorage.removeItem(QUALITY_KEY);
    else localStorage.setItem(QUALITY_KEY, value);
  } catch {
    /* Unavailable storage keeps the default. */
  }
}

export async function shrinkPhoto(blob: Blob, name: string, lastModified = Date.now(), quality = photoQuality()): Promise<File> {
  if (quality !== 'original')
    try {
      const size = SIZES[quality];
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      const scale = Math.min(1, size.edge / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const shrunk = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', size.quality));
      if (shrunk) return new File([shrunk], name, { type: 'image/jpeg', lastModified });
    } catch {
      /* Undecodable here: the original goes as it is. */
    }
  return new File([blob], name, { type: 'image/jpeg', lastModified });
}

// Queues the photo `photoId` for `date`. The photo's ID is the operation key,
// so queueing or sending it again never adds it twice. Returns whether it waits
// for the journal to be unlocked here.
export async function queuePhoto(journal: PhotoJournal, date: string, photoId: string, file: File) {
  const keyId = journal.key_id ?? null;
  if (keyId && !isUnlocked(keyId)) {
    await queueOutboxRecord({ journalId: journal.id, keyId, date, title: '', text: '', operationKey: photoId, photos: [file] });
    return { locked: true };
  }
  const draftId = photoDraftId(journal.id, date, photoId);
  if (hasDraft(draftId)) return { locked: false, draftId };
  await keepPhoto(draftId, photoId, file, keyId);
  markQuickRecord(draftId, keyId);
  const stored = await writeDraft(draftId, {
    content: JSON.stringify({ title: '', text: '', attachments: [], operationKey: photoId, retrying: true, queued: true }),
    attachments: [], revision: 0, savedAt: Date.now(),
  }, keyId);
  if (!stored) {
    await dropPhotos(draftId);
    markQuickRecord(draftId, keyId, false);
    throw new Error('本机存储不可用，照片没能记下。');
  }
  return { locked: false, draftId };
}
