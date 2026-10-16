import type { AuthStatus, FileInfo, NoteDetail, NoteNode } from '../shared/types';
import { FOLDER_ICON_MAX_BYTES } from '../shared/folder-icons';
import { clearDrafts } from './note-drafts';
import { openBlob } from './encryption';
import { withRequestTimeout } from './request-timeout';

// Private content lives in IndexedDB, never the public service-worker cache.
// A document and all its files are committed as one snapshot. An interrupted
// refresh cannot turn a previously pinned document into a partial download.
interface CachedFile {
  id: string;
  blob: Blob;
}
interface CachedNote {
  id: string;
  detail: NoteDetail;
  files: CachedFile[];
  fileIds: string[];
  complete: boolean;
  pinned: boolean;
  bytes: number;
  accessedAt: number;
  savedAt: number;
  error?: string;
  // Fetched ahead of opening (src/prefetch.ts): the body only, first to go.
  prefetched?: boolean;
}
// Folder icon blobs are immutable, so a saved copy never needs revalidation.
interface CachedIcon {
  id: string;
  blob: Blob;
  savedAt: number;
}
interface CachedResponse {
  path: string;
  value: unknown;
  bytes: number;
  savedAt: number;
}
export interface CacheSummary {
  node: NoteNode;
  complete: boolean;
  pinned: boolean;
  bytes: number;
  accessedAt: number;
  savedAt: number;
  error?: string;
}
export interface CacheSnapshot {
  notes: CacheSummary[];
  bytes: number;
  limit: number;
  supported: boolean;
  error: string;
}
const DEFAULT_LIMIT = 200_000_000;
const epochKey = 'note:cache-epoch';
const limitKey = 'note:cache-limit';
const storeNames = ['notes', 'responses', 'icons'] as const;
const ICON_LIMIT = 200;
let database: Promise<IDBDatabase> | undefined;
const listeners = new Set<() => void>();
let snapshot: CacheSnapshot = {
  notes: [],
  bytes: 0,
  limit: readLimit(),
  supported: 'indexedDB' in window,
  error: '',
};
let generation = 0;
let privateGeneration = 0;
let downloadController = new AbortController();
let queue: Promise<unknown> = Promise.resolve();
let refreshSequence = 0;
const iconUrls = new Map<string, string>();

export function cacheEpoch() {
  try {
    return localStorage.getItem(epochKey) || 'initial';
  } catch {
    return String(generation);
  }
}
function invalidateJobs(privateData = false) {
  generation++;
  if (privateData) {
    privateGeneration++;
    for (const url of iconUrls.values()) URL.revokeObjectURL(url);
    iconUrls.clear();
    downloadController.abort();
    downloadController = new AbortController();
  }
}
function advanceEpoch(prefix = 'cache') {
  invalidateJobs(prefix === 'signed-out');
  try {
    localStorage.setItem(epochKey, `${prefix}:${crypto.randomUUID()}`);
  } catch {
    /* Optional cross-tab signal. */
  }
}
window.addEventListener('storage', (event) => {
  if (event.key === epochKey) {
    invalidateJobs(event.newValue?.startsWith('signed-out:'));
    void refreshSnapshot();
    window.dispatchEvent(new Event('note:cache-reset'));
  }
  if (event.key === limitKey) void refreshSnapshot();
});
const channel =
  typeof BroadcastChannel === 'function' ? new BroadcastChannel('note:offline') : null;
channel?.addEventListener('message', () => {
  void refreshSnapshot();
});

function readLimit() {
  try {
    const value = Number(localStorage.getItem(limitKey));
    return Number.isFinite(value) && value >= 20_000_000 && value <= 2_000_000_000
      ? value
      : DEFAULT_LIMIT;
  } catch {
    return DEFAULT_LIMIT;
  }
}
function openDatabase() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('yejian-offline', 4);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (event.oldVersion < 1) {
        db.createObjectStore('notes', { keyPath: 'id' }).createIndex('fileIds', 'fileIds', {
          multiEntry: true,
        });
        db.createObjectStore('responses', { keyPath: 'path' });
      }
      if (event.oldVersion < 2) db.createObjectStore('icons', { keyPath: 'id' });
      // Eviction walks keys oldest first instead of reading every icon blob.
      if (event.oldVersion < 3)
        request.transaction!.objectStore('icons').createIndex('savedAt', 'savedAt');
      // Before 0.4.25, notes fetched ahead were kept after decryption: their
      // sealed fields (summaries and the like) were stored in the clear.
      if (event.oldVersion >= 1 && event.oldVersion < 4) {
        const notes = request.transaction!.objectStore('notes').openCursor();
        notes.onsuccess = () => {
          const cursor = notes.result;
          if (!cursor) return;
          if ((cursor.value as CachedNote).prefetched) cursor.delete();
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        database = undefined;
      };
      resolve(request.result);
    };
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
  }));
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}
async function transaction<T>(
  mode: IDBTransactionMode,
  action: (tx: IDBTransaction) => Promise<T>,
) {
  const db = await openDatabase();
  const tx = db.transaction([...storeNames], mode);
  const completed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('本机缓存操作已取消。'));
    tx.onerror = () => {}; // onabort is the authoritative transaction result.
  });
  try {
    const value = await action(tx);
    await completed;
    return value;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* Already aborted/completed. */
    }
    await completed.catch(() => {});
    throw error;
  }
}
function emit() {
  listeners.forEach((listener) => listener());
}
export function subscribeCache(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export const cacheSnapshot = () => snapshot;
async function refreshSnapshot() {
  const sequence = ++refreshSequence;
  try {
    const notes = await transaction('readonly', (tx) =>
      request<CachedNote[]>(tx.objectStore('notes').getAll()),
    );
    if (sequence !== refreshSequence) return;
    snapshot = {
      notes: notes
        .filter((note) => !note.prefetched)
        .sort((a, b) => b.accessedAt - a.accessedAt)
        .map(({ detail, ...note }) => {
          const {
            content: _content,
            attachments: _attachments,
            breadcrumbs: _breadcrumbs,
            file: _file,
            ...node
          } = detail;
          return {
            node,
            complete: note.complete,
            pinned: note.pinned,
            bytes: note.bytes,
            accessedAt: note.accessedAt,
            savedAt: note.savedAt,
            error: note.error,
          };
        }),
      bytes: notes.reduce((sum, note) => sum + note.bytes, 0),
      limit: readLimit(),
      supported: true,
      error: '',
    };
  } catch {
    if (sequence !== refreshSequence) return;
    snapshot = { ...snapshot, supported: false, error: '此设备暂时无法使用本机缓存。' };
  }
  emit();
}
export async function initializeCache() {
  await refreshSnapshot();
}
async function changed() {
  await refreshSnapshot();
  channel?.postMessage('changed');
}
function bytes(value: unknown) {
  return new Blob([JSON.stringify(value)]).size;
}
function stored(detail: NoteDetail): NoteDetail {
  if (!detail.sealed) return detail;
  const { locked: _locked, ...rest } = detail;
  return { ...rest, content: '' };
}
function noteFiles(note: NoteDetail): FileInfo[] {
  const files = new Map(note.attachments.map((file) => [file.id, file]));
  if (note.file) files.set(note.file.id, note.file);
  if (note.icon_blob_id)
    files.set(note.icon_blob_id, { id: note.icon_blob_id, name: '', mime: '', size: 0 });
  if (note.book?.cover_blob_id)
    files.set(note.book.cover_blob_id, { id: note.book.cover_blob_id, name: '', mime: '', size: 0 });
  // Uploaded images can also be referenced by another note's Markdown.
  for (const match of note.content.matchAll(/\/api\/files\/([a-zA-Z0-9_-]+)/g))
    if (!files.has(match[1])) files.set(match[1], { id: match[1], name: '', mime: '', size: 0 });
  return [...files.values()];
}
export async function cachedFile(id: string): Promise<Blob | null> {
  return transaction('readonly', async (tx) => {
    const note = await request<CachedNote | undefined>(
      tx.objectStore('notes').index('fileIds').get(id),
    );
    const blob = note?.files.find((file) => file.id === id)?.blob;
    if (blob) return blob;
    return (await request<CachedIcon | undefined>(tx.objectStore('icons').get(id)))?.blob ?? null;
  }).catch(() => null);
}
const fileRequests = new Map<string, Promise<Blob>>();
export function shareFileDownload(id: string, download: Promise<Blob>) {
  const key = `${privateGeneration}:${id}`;
  if (fileRequests.has(key)) return;
  fileRequests.set(key, download);
  void download
    .finally(() => {
      if (fileRequests.get(key) === download) fileRequests.delete(key);
    })
    .catch(() => {});
}
// A file to show: decrypted when it is sealed (which needs its key unlocked).
export async function fileBlob(id: string, options?: { cached?: boolean }): Promise<Blob> {
  return openBlob(await rawFile(id, options));
}
// A file as stored: what the offline cache keeps, sealed or not.
export function rawFile(id: string, { cached = true } = {}): Promise<Blob> {
  // Removing an unrelated cached note must not abort the PDF currently opening.
  // Only a session reset cancels foreground file reads.
  const epoch = privateGeneration;
  const key = `${epoch}:${id}`;
  const pending = fileRequests.get(key);
  if (pending) return pending;
  const signal = downloadController.signal;
  const result = (async () => {
    const saved = cached ? await cachedFile(id) : null;
    if (epoch !== privateGeneration) throw new Error('缓存操作已取消。');
    if (saved) return saved;
    return withRequestTimeout(90_000, async (requestSignal) => {
      const response = await fetch(`/api/files/${encodeURIComponent(id)}`, {
        credentials: 'same-origin',
        redirect: 'error',
        signal: requestSignal,
      });
      if (response.status === 401) {
        await clearPrivateCache();
        window.dispatchEvent(new Event('note:unauthenticated'));
      }
      if (response.status !== 200) throw new Error('文件尚未缓存，请联网后重试。');
      const blob = await response.blob();
      if (epoch !== privateGeneration) throw new Error('缓存操作已取消。');
      const expected = Number(response.headers.get('content-length'));
      if (expected && blob.size !== expected) throw new Error('文件下载不完整，请重试。');
      return blob;
    }, signal);
  })();
  fileRequests.set(key, result);
  void result.finally(() => fileRequests.delete(key)).catch(() => {});
  return result;
}
// Synchronous lookup lets a remounted list render known icons without a flash.
export const loadedIcon = (id: string) => iconUrls.get(id);
const iconRequests = new Map<string, Promise<string>>();
export function iconImage(id: string): Promise<string> {
  const known = iconUrls.get(id);
  if (known) return Promise.resolve(known);
  const epoch = privateGeneration,
    cache = cacheEpoch();
  const key = `${epoch}:${id}`;
  const pending = iconRequests.get(key);
  if (pending) return pending;
  const result = (async () => {
    // One read covers both saved notes and saved icons before the network.
    const saved = await cachedFile(id);
    const blob = saved ?? (await rawFile(id, { cached: false }));
    if (epoch !== privateGeneration) throw new Error('缓存操作已取消。');
    if (!saved) void rememberIcon(id, blob, cache).catch(() => {});
    const url = iconUrls.get(id) ?? URL.createObjectURL(await openBlob(blob));
    iconUrls.set(id, url);
    return url;
  })();
  iconRequests.set(key, result);
  void result.finally(() => iconRequests.delete(key)).catch(() => {});
  return result;
}
async function rememberIcon(id: string, blob: Blob, epoch: string) {
  if (blob.size > FOLDER_ICON_MAX_BYTES) return;
  await transaction('readwrite', async (tx) => {
    if (epoch !== cacheEpoch()) return;
    if (!(await request(tx.objectStore('responses').get('/api/auth/status')))) return;
    const store = tx.objectStore('icons');
    let excess = (await request(store.count())) + 1 - ICON_LIMIT;
    if (excess > 0)
      await new Promise<void>((resolve, reject) => {
        const cursor = store.index('savedAt').openKeyCursor();
        cursor.onerror = () => reject(cursor.error);
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (!current || excess-- <= 0) return resolve();
          store.delete(current.primaryKey);
          current.continue();
        };
      });
    store.put({ id, blob, savedAt: Date.now() } satisfies CachedIcon);
  });
}
export async function cachedNote(id: string): Promise<NoteDetail | undefined> {
  return transaction('readwrite', async (tx) => {
    const store = tx.objectStore('notes');
    const value = await request<CachedNote | undefined>(store.get(id));
    if (value) {
      value.accessedAt = Date.now();
      store.put(value);
    }
    return value?.detail;
  }).catch(() => undefined);
}
export const cacheablePath = (path: string) =>
  path === '/api/auth/status' ||
  path === '/api/storage' ||
  path === '/api/storage/usage' ||
  path === '/api/clips' ||
  path === '/api/clips?view=archived' ||
  // 青藜's global conversation (its latest page) and whether it is set up, so
  // the 问青藜 window and panel open with the last conversation.
  path === '/api/nodes/qingli-global/assistant' ||
  path === '/api/ai/settings' ||
  /^\/api\/nodes(?:\?.*)?$/.test(path) ||
  /^\/api\/nodes\/[\w-]+\/annotations$/.test(path) ||
  /^\/api\/nodes\/[\w-]+\/pages$/.test(path) ||
  /^\/api\/nodes\/[\w-]+\/journal\?month=\d{4}-\d{2}$/.test(path);

export async function cachedResponse<T>(path: string): Promise<T | undefined> {
  const id = path.match(/^\/api\/nodes\/([\w-]+)$/)?.[1];
  if (id) return (await cachedNote(id)) as T | undefined;
  if (!cacheablePath(path)) return undefined;
  return transaction(
    'readonly',
    async (tx) =>
      (await request<CachedResponse | undefined>(tx.objectStore('responses').get(path)))?.value as
        T | undefined,
  ).catch(() => undefined);
}
export async function rememberResponse(path: string, value: unknown, epoch: string) {
  if (!cacheablePath(path)) return;
  // Password derivation metadata and authentication responses are never stored.
  if (path === '/api/auth/status') {
    const status = value as AuthStatus;
    if (!status.authenticated) return;
    if (epoch === cacheEpoch() && epoch.startsWith('signed-out:')) {
      advanceEpoch('session');
      epoch = cacheEpoch();
    }
    value = { authenticated: true, initialized: true, name: status.name };
  }
  await transaction('readwrite', async (tx) => {
    if (epoch !== cacheEpoch()) return;
    if (
      path !== '/api/auth/status' &&
      !(await request<CachedResponse | undefined>(
        tx.objectStore('responses').get('/api/auth/status'),
      ))
    )
      return;
    const store = tx.objectStore('responses');
    const entries = await request<CachedResponse[]>(store.getAll());
    const entry = { path, value, bytes: bytes(value), savedAt: Date.now() };
    let total = entry.bytes;
    // Directory snapshots have an independent, small 2 MB ceiling.
    for (const old of entries
      .filter((item) => item.path !== path)
      .sort((a, b) => b.savedAt - a.savedAt)) {
      total += old.bytes;
      if (total > 2_000_000 && old.path !== '/api/auth/status') store.delete(old.path);
    }
    store.put(entry);
  });
}
async function commitNote(
  detail: NoteDetail,
  files: CachedFile[],
  complete: boolean,
  pin: boolean,
  epoch: string,
) {
  await transaction('readwrite', async (tx) => {
    if (epoch !== cacheEpoch()) throw new Error('缓存操作已取消。');
    const store = tx.objectStore('notes');
    const session = await request<CachedResponse | undefined>(
      tx.objectStore('responses').get('/api/auth/status'),
    );
    if (!session || epoch !== cacheEpoch()) throw new Error('请重新登录后缓存文件。');
    const notes = await request<CachedNote[]>(store.getAll());
    const previous = notes.find((note) => note.id === detail.id);
    if (previous && previous.detail.revision > detail.revision) {
      if (pin && previous.complete) {
        previous.pinned = true;
        store.put(previous);
      }
      return;
    }
    if (previous?.pinned && !complete) {
      previous.error = '离线副本尚未更新';
      store.put(previous);
      return;
    }
    const entry: CachedNote = {
      id: detail.id,
      detail,
      files,
      fileIds: files.map((file) => file.id),
      complete,
      pinned: pin || !!previous?.pinned,
      bytes: bytes(detail) + files.reduce((sum, file) => sum + file.blob.size, 0),
      accessedAt: Date.now(),
      savedAt: Date.now(),
    };
    const others = notes.filter((note) => note.id !== detail.id);
    let total = others.reduce((sum, note) => sum + note.bytes, entry.bytes);
    const removable = others
      .filter((note) => !note.pinned)
      .sort((a, b) => a.accessedAt - b.accessedAt);
    const evict: string[] = [];
    while (
      (total > readLimit() || removable.length + (entry.pinned ? 0 : 1) > 100) &&
      removable.length
    ) {
      const old = removable.shift()!;
      total -= old.bytes;
      evict.push(old.id);
    }
    if (total > readLimit()) throw new Error('本机缓存空间不足，请提高上限或移除部分离线保存。');
    for (const id of evict) store.delete(id);
    store.put(entry);
  });
  await changed();
}
// A note fetched before it is opened (src/prefetch.ts): only its body, never its
// files, marked least recently read so it is the first to go. It never makes
// room for itself: a full cache simply skips it.
// `detail` is the server's response, before reveal(), and `epoch` the one its
// request started in.
export async function rememberPrefetched(detail: NoteDetail, epoch: string) {
  let added = false;
  await transaction('readwrite', async (tx) => {
    if (epoch !== cacheEpoch()) return;
    if (!(await request<CachedResponse | undefined>(tx.objectStore('responses').get('/api/auth/status')))) return;
    const store = tx.objectStore('notes');
    const notes = await request<CachedNote[]>(store.getAll());
    if (notes.some((note) => note.id === detail.id)) return;
    const body = stored(detail);
    const entry: CachedNote = {
      id: body.id, detail: body, files: [], fileIds: [], complete: false, pinned: false,
      bytes: bytes(body), accessedAt: 0, savedAt: Date.now(), prefetched: true,
    };
    const total = notes.reduce((sum, note) => sum + note.bytes, entry.bytes);
    if (notes.filter((note) => !note.pinned).length >= 100 || total > readLimit()) return;
    store.put(entry);
    added = true;
  });
  if (added) await changed();
  return added;
}
// Notes whose titles hold every word, from what this device has seen: cached
// directory listings and note copies. Shown while the server searches, and
// alone when it cannot be reached.
export async function searchCachedTitles(words: string[], limit = 30, options: import('../shared/search').SearchOptions = {}): Promise<(NoteNode & { ancestor_ids?: string[] })[]> {
  const { compareSearch, matchesSearchType } = await import('../shared/search');
  const lower = words.map((word) => word.toLowerCase());
  const found = new Map<string, NoteNode>();
  const catalog = new Map<string, NoteNode>();
  const paths = new Map<string, string[]>();
  const consider = (node: NoteNode | undefined) => {
    if (!node?.id || node.trash_id) return;
    if (!catalog.has(node.id)) catalog.set(node.id, node);
    if (found.has(node.id)) return;
    const title = (node.title ?? '').toLowerCase();
    if (lower.every((word) => title.includes(word))) found.set(node.id, node);
  };
  await transaction('readonly', async (tx) => {
    const [responses, notes] = await Promise.all([
      request<CachedResponse[]>(tx.objectStore('responses').getAll()),
      request<CachedNote[]>(tx.objectStore('notes').getAll()),
    ]);
    for (const note of notes) {
      paths.set(note.id, note.detail.breadcrumbs.slice(0, -1).map((part) => part.id));
      const { content: _content, attachments: _attachments, breadcrumbs: _breadcrumbs, file: _file, ...node } = note.detail;
      consider(node as NoteNode);
    }
    for (const response of responses)
      if (/^\/api\/nodes(?:\?|$)/.test(response.path))
        for (const node of (response.value as { nodes?: NoteNode[] })?.nodes ?? []) consider(node);
  }).catch(() => {});
  const ancestors = (node: NoteNode) => {
    if (paths.has(node.id)) return paths.get(node.id)!;
    const ids: string[] = [];
    let parent = node.parent_id;
    while (parent && ids.length < 200 && !ids.includes(parent)) {
      ids.push(parent);
      parent = catalog.get(parent)?.parent_id ?? null;
    }
    return ids;
  };
  return [...found.values()].map((node) => ({ ...node, ancestor_ids: ancestors(node) }))
    .filter((node) => matchesSearchType(node, options.type) && (!options.parent || node.ancestor_ids.includes(options.parent)))
    .sort((a, b) => compareSearch(a, b, words, options.sort)).slice(0, limit);
}
// Encrypted notes kept here (bodies still sealed), for searching on the device.
export async function cachedSealedNotes(): Promise<NoteDetail[]> {
  return transaction('readonly', async (tx) =>
    (await request<CachedNote[]>(tx.objectStore('notes').getAll()))
      .map((note) => note.detail)
      .filter((detail) => typeof detail.sealed === 'string' && !!detail.key_id && !detail.trash_id),
  ).catch(() => []);
}
// Whether a note has a copy here, without counting as reading it.
export async function hasCachedNote(id: string) {
  return transaction('readonly', async (tx) => !!(await request(tx.objectStore('notes').getKey(id)))).catch(() => true);
}
const pending = new Map<string, Promise<void>>();
export function rememberNote(
  detail: NoteDetail,
  pin = false,
  epoch = cacheEpoch(),
  downloaded?: CachedFile,
): Promise<void> {
  const key = `${epoch}:${detail.id}:${detail.revision}:${pin}:${!!downloaded}`;
  const existing = pending.get(key);
  if (existing) return existing;
  // Only the sealed body of an encrypted note is kept, never its text.
  const plain = detail;
  detail = stored(detail);
  const job = async () => {
    if (epoch !== cacheEpoch()) throw new Error('缓存操作已取消。');
    // A PDF reader streams its first pages immediately and supplies getData()
    // when the full file arrives. Do not make a second request in the background.
    if (!pin && !downloaded && detail.kind === 'pdf' && detail.file) {
      const blob = await cachedFile(detail.file.id);
      await commitNote(detail, blob ? [{ id: detail.file.id, blob }] : [], !!blob, false, epoch);
      return;
    }
    const descriptors = noteFiles(plain);
    if (bytes(detail) + descriptors.reduce((sum, file) => sum + file.size, 0) > readLimit())
      throw new Error('此文件超过本机缓存上限，请先在设置中提高上限。');
    const files: CachedFile[] = [];
    let failure: Error | undefined;
    for (const file of descriptors) {
      try {
        if (epoch !== cacheEpoch()) throw new Error('缓存操作已取消。');
        const blob = downloaded?.id === file.id ? downloaded.blob : await rawFile(file.id);
        if (file.size && blob.size !== file.size) throw new Error('文件下载不完整，请重试。');
        files.push({ id: file.id, blob });
        if (bytes(detail) + files.reduce((sum, item) => sum + item.blob.size, 0) > readLimit())
          throw new Error('此文件超过本机缓存上限，请先在设置中提高上限。');
      } catch (error) {
        failure = error as Error;
        break;
      }
    }
    if (epoch !== cacheEpoch()) throw new Error('缓存操作已取消。');
    if (failure && pin) throw failure;
    await commitNote(detail, files, !failure, pin, epoch);
  };
  // Serialize large downloads; transactions protect commits between tabs too.
  const result = queue.then(job).catch(async (error) => {
    await transaction('readwrite', async (tx) => {
      if (epoch !== cacheEpoch()) return;
      const store = tx.objectStore('notes');
      const previous = await request<CachedNote | undefined>(store.get(detail.id));
      if (previous?.pinned && previous.detail.revision < detail.revision) {
        previous.error = '离线副本尚未更新';
        store.put(previous);
      }
    }).catch(() => {});
    await changed();
    throw error;
  });
  queue = result.catch(() => {});
  pending.set(key, result);
  void result
    .finally(() => {
      pending.delete(key);
    })
    .catch(() => {});
  return result;
}
export async function unpinNote(id: string) {
  await transaction('readwrite', async (tx) => {
    const store = tx.objectStore('notes');
    const entry = await request<CachedNote | undefined>(store.get(id));
    if (entry) {
      entry.pinned = false;
      store.put(entry);
    }
  });
  await changed();
}
export async function removeCachedNote(id: string) {
  advanceEpoch();
  await transaction('readwrite', async (tx) => {
    const store = tx.objectStore('notes');
    const notes = await request<CachedNote[]>(store.getAll());
    for (const note of notes)
      if (note.id === id || note.detail.breadcrumbs.some((part) => part.id === id))
        store.delete(note.id);
    // Deletions/moves invalidate directory snapshots, never serve an old tree.
    const responses = tx.objectStore('responses');
    const keys = await request<IDBValidKey[]>(responses.getAllKeys());
    for (const key of keys) if (String(key).startsWith('/api/nodes')) responses.delete(key);
  });
  await changed();
}
export async function setCacheLimit(limit: number) {
  if (!Number.isFinite(limit) || limit < 20_000_000 || limit > 2_000_000_000)
    throw new Error('缓存上限应为 20–2000 MB。');
  await transaction('readwrite', async (tx) => {
    const store = tx.objectStore('notes');
    const notes = await request<CachedNote[]>(store.getAll());
    if (notes.filter((note) => note.pinned).reduce((sum, note) => sum + note.bytes, 0) > limit)
      throw new Error('已离线保存的文件超过此上限，请先移除部分离线保存。');
    let total = notes.reduce((sum, note) => sum + note.bytes, 0);
    for (const note of notes
      .filter((note) => !note.pinned)
      .sort((a, b) => a.accessedAt - b.accessedAt)) {
      if (total <= limit) break;
      store.delete(note.id);
      total -= note.bytes;
    }
  });
  localStorage.setItem(limitKey, String(limit));
  await changed();
}
export async function clearRecentCache() {
  advanceEpoch();
  await transaction('readwrite', async (tx) => {
    const store = tx.objectStore('notes');
    const notes = await request<CachedNote[]>(store.getAll());
    for (const note of notes) if (!note.pinned) store.delete(note.id);
    tx.objectStore('icons').clear();
  });
  await changed();
}
export async function clearPrivateCache() {
  clearDrafts();
  if (!cacheEpoch().startsWith('signed-out:')) advanceEpoch('signed-out');
  else invalidateJobs(true);
  await transaction('readwrite', async (tx) => {
    for (const store of storeNames) tx.objectStore(store).clear();
  }).catch(() => {});
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith('reading:') || key.startsWith('pdf-view:'))
        localStorage.removeItem(key);
    sessionStorage.removeItem('expanded-nodes');
  } catch {
    /* Storage can be unavailable. */
  }
  await changed();
}
