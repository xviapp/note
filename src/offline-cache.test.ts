import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Cache = typeof import('./offline-cache');
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const fetchFile = vi.fn(
  async () =>
    new Response(png, {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(png.length) },
    }),
);

// Each import is a fresh page load; IndexedDB (fake-indexeddb) persists between them.
async function load(): Promise<Cache> {
  vi.resetModules();
  const cache = await import('./offline-cache');
  await cache.rememberResponse(
    '/api/auth/status',
    { authenticated: true, initialized: true, name: '页间' },
    cache.cacheEpoch(),
  );
  return cache;
}
async function savedIcons() {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('yejian-offline');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  const count = await new Promise<number>((resolve) => {
    const request = db.transaction('icons').objectStore('icons').count();
    request.onsuccess = () => resolve(request.result);
  });
  db.close();
  return count;
}
// Icons are saved in the background after they display.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('folder icon cache', () => {
  beforeEach(() => {
    localStorage.clear();
    fetchFile.mockClear();
    vi.stubGlobal('fetch', fetchFile);
    let next = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:icon-${next++}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    const cache = await import('./offline-cache');
    await cache.clearPrivateCache();
  });

  it('downloads an icon once and reuses it in this session and after a restart', async () => {
    let cache = await load();
    const url = await cache.iconImage('icon-a');
    expect(cache.loadedIcon('icon-a')).toBe(url);
    expect(await cache.iconImage('icon-a')).toBe(url);
    expect(fetchFile).toHaveBeenCalledTimes(1);
    await settle();
    expect(await savedIcons()).toBe(1);

    cache = await load();
    expect(cache.loadedIcon('icon-a')).toBeUndefined();
    await cache.iconImage('icon-a');
    expect(fetchFile).toHaveBeenCalledTimes(1);
  });

  it('keeps at most 200 icons, evicting the oldest', async () => {
    const cache = await load();
    for (let i = 0; i <= 200; i++) {
      await cache.iconImage(`icon-${i}`);
      await settle();
    }
    expect(await savedIcons()).toBe(200);
    fetchFile.mockClear();
    const restarted = await load();
    await restarted.iconImage('icon-200');
    expect(fetchFile).not.toHaveBeenCalled();
    await restarted.iconImage('icon-0');
    expect(fetchFile).toHaveBeenCalledTimes(1);
  });

  it('forgets icons when the private cache is cleared on sign-out', async () => {
    const cache = await load();
    await cache.iconImage('icon-a');
    await settle();
    await cache.clearPrivateCache();
    expect(cache.loadedIcon('icon-a')).toBeUndefined();
    expect(await savedIcons()).toBe(0);
  });
});

describe('file download cancellation', () => {
  beforeEach(() => {
    vi.stubGlobal('AbortSignal', new Proxy(AbortSignal, {
      get: (target, property, receiver) => ['timeout', 'any'].includes(String(property))
        ? undefined : Reflect.get(target, property, receiver),
    }));
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    const cache = await import('./offline-cache');
    await cache.clearPrivateCache();
  });

  it('downloads files without AbortSignal.timeout or AbortSignal.any', async () => {
    const cache = await load();
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchFile);
    const blob = await cache.rawFile('compatible-file', { cached: false });
    expect(blob.size).toBe(png.length);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the timeout active while reading the file body', async () => {
    const cache = await load();
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_path, options: RequestInit) => {
      const response = new Response(png);
      vi.spyOn(response, 'blob').mockImplementation(() => new Promise((_resolve, reject) => {
        options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
        vi.advanceTimersByTime(90_000);
      }));
      return response;
    }));
    await expect(cache.rawFile('stalled-file', { cached: false })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an active download when the session is cleared', async () => {
    const cache = await load();
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_path, options: RequestInit) => new Promise((_resolve, reject) => {
      signal = options.signal!;
      signal.addEventListener('abort', () => reject(signal!.reason), { once: true });
    })));
    const download = expect(cache.rawFile('cancelled-file', { cached: false })).rejects.toMatchObject({ name: 'AbortError' });
    expect(signal?.aborted).toBe(false);
    await cache.clearPrivateCache();
    await download;
    expect(signal?.aborted).toBe(true);
  });
});
