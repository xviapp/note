import { openBytes, sealBytes } from '../shared/encryption';
import { unlockedKey } from './keyring';
import { draftEpoch } from './note-drafts';

// Photos chosen for a quick record but not uploaded yet. They stay on this
// device until uploaded (sealed with the note's key in an encrypted place), so
// a closed window or an app Android reclaimed can finish the upload later.
// Cleared with the drafts on sign-out (see clearDrafts).
interface Stored {
  draft: string;
  id: string;
  name: string;
  type: string;
  lastModified: number;
  bytes: ArrayBuffer;
  // When it was chosen, for the order of the record's photos.
  addedAt: number;
  // The key the bytes are sealed with, when the note is encrypted.
  keyId: string | null;
}
export interface PendingPhoto {
  id: string;
  file: File;
}

let database: Promise<IDBDatabase> | undefined;
let sequence = 0;
function open() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('yejian-pending-photos', 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore('photos', { keyPath: ['draft', 'id'] }).createIndex('draft', 'draft');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
  }));
}
async function store<T>(mode: IDBTransactionMode, action: (photos: IDBObjectStore) => IDBRequest<T> | void) {
  const db = await open();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction('photos', mode);
    const request = action(tx.objectStore('photos'));
    tx.oncomplete = () => resolve(request?.result);
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}

export async function keepPhoto(draft: string, id: string, file: File, keyId?: string | null) {
  // Sign-out clears the photos; one still being read or sealed is not kept.
  const started = draftEpoch();
  let bytes: ArrayBuffer = await file.arrayBuffer();
  if (keyId) {
    const key = await unlockedKey(keyId);
    // A locked key keeps the photo in memory only; it is never stored in the clear.
    if (!key) return;
    bytes = (await sealBytes(key, keyId, new Uint8Array(bytes))).buffer;
  }
  const value: Stored = {
    draft, id, name: file.name, type: file.type, lastModified: file.lastModified, bytes,
    addedAt: Date.now() * 1000 + (sequence++ % 1000), keyId: keyId ?? null,
  };
  await store('readwrite', (photos) => {
    if (draftEpoch() === started) photos.put(value);
  });
}

// The draft's photos still waiting, in the order chosen; sealed ones need their key unlocked.
export async function pendingPhotos(draft: string): Promise<PendingPhoto[]> {
  const rows =
    (await store<Stored[]>('readonly', (photos) => photos.index('draft').getAll(draft)).catch(() => [])) ?? [];
  const result: PendingPhoto[] = [];
  for (const row of rows.sort((a, b) => a.addedAt - b.addedAt)) {
    let bytes: ArrayBuffer = row.bytes;
    if (row.keyId) {
      const key = await unlockedKey(row.keyId);
      if (!key) continue;
      bytes = (await openBytes(key, new Uint8Array(bytes)).catch(() => null))?.buffer as ArrayBuffer;
      if (!bytes) continue;
    }
    result.push({
      id: row.id,
      file: new File([bytes], row.name, { type: row.type, lastModified: row.lastModified }),
    });
  }
  return result;
}

export const dropPhoto = (draft: string, id: string) =>
  store('readwrite', (photos) => photos.delete([draft, id])).catch(() => {});

export async function dropPhotos(draft?: string) {
  await store('readwrite', (photos) => {
    if (!draft) return photos.clear();
    const range = IDBKeyRange.bound([draft, ''], [draft, '￿']);
    return photos.delete(range);
  }).catch(() => {});
}
