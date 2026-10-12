import { expect, it } from 'vitest';

// A cache written by 0.4.24 (version 3): one note fetched ahead, kept after
// decryption, and one opened by the reader.
async function oldCache() {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('yejian-offline', 3);
    request.onupgradeneeded = () => {
      const created = request.result;
      created.createObjectStore('notes', { keyPath: 'id' }).createIndex('fileIds', 'fileIds', { multiEntry: true });
      created.createObjectStore('responses', { keyPath: 'path' });
      created.createObjectStore('icons', { keyPath: 'id' }).createIndex('savedAt', 'savedAt');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const note = (id: string, extra: object) => ({
    id, detail: { id, title: id, content: '', attachments: [], breadcrumbs: [], ...extra },
    files: [], fileIds: [], complete: false, pinned: false, bytes: 10, accessedAt: 0, savedAt: 0, ...extra,
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['notes', 'responses'], 'readwrite');
    tx.objectStore('notes').put(note('ahead', { prefetched: true, summary: '明文摘要' }));
    tx.objectStore('notes').put(note('opened', {}));
    tx.objectStore('responses').put({ path: '/api/auth/status', value: { authenticated: true, initialized: true } });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

it('drops the notes an older version fetched ahead in the clear, and keeps the rest', async () => {
  await oldCache();
  const cache = await import('./offline-cache');
  expect(await cache.cachedNote('ahead')).toBeUndefined();
  expect(await cache.cachedNote('opened')).toMatchObject({ id: 'opened' });
});
