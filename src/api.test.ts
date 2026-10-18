import { afterEach, expect, it, vi } from 'vitest';
import { api, uncertainFailure } from './api';
import { isOffline, setOffline } from './connectivity';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setOffline(false);
});

it('can load authentication status without AbortSignal.timeout', async () => {
  vi.stubGlobal('AbortSignal', new Proxy(AbortSignal, {
    get: (target, property, receiver) => property === 'timeout' ? undefined : Reflect.get(target, property, receiver),
  }));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ authenticated: false, initialized: true })));
  await expect(api('/api/auth/status')).resolves.toEqual({ authenticated: false, initialized: true });
});

it('releases stalled writes without retrying and allows an explicit retry with the same key', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockImplementationOnce((_path, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
    vi.advanceTimersByTime(30_000);
  })).mockResolvedValueOnce(Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetcher);
  setOffline(false);
  const error = await api('/api/site', 'PATCH', { name: '页间' }, 'same-operation').catch((reason) => reason);
  expect(error).toMatchObject({ status: 0, code: 'REQUEST_TIMEOUT' });
  expect(uncertainFailure(error)).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(isOffline()).toBe(false);
  await api('/api/site', 'PATCH', { name: '页间' }, 'same-operation');
  expect(fetcher.mock.calls.map((call) => call[1].headers['x-idempotency-key'])).toEqual(['same-operation', 'same-operation']);
});

it('allows long AI work to finish within its provider budget', async () => {
  const timeout = vi.spyOn(globalThis, 'setTimeout');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ prompt: '阅读助手' })));
  setOffline(false);
  await api('/api/books/role-prompt', 'POST', { title: '书籍' });
  expect(timeout).toHaveBeenCalledWith(expect.any(Function), 25 * 60_000);
});

it('copies files another note uses and saves with the copies', async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetcher = vi.fn(async (path: string, options: RequestInit = {}) => {
    if (path === '/api/nodes/n1/keys') return Response.json({ key_id: null, chain: [] });
    if (path === '/api/files/f1') return new Response('图片');
    if (path.startsWith('/api/files?')) return Response.json({ id: 'f2', name: 'a.png', mime: 'image/png', size: 6 });
    const body = JSON.parse(String(options.body));
    bodies.push(body);
    return bodies.length === 1
      ? Response.json(
        { error: '附件也被其他笔记使用。', code: 'FILES_SHARED', files: [{ id: 'f1', name: 'a.png', mime: 'image/png' }] },
        { status: 409 },
      )
      : Response.json({ id: 'n1', revision: 2 });
  });
  vi.stubGlobal('fetch', fetcher);
  await api('/api/nodes/n1/content', 'PUT', { content: '![](/api/files/f1) /api/files/f10', attachments: ['f1'], revision: 1 }, 'save');
  expect(bodies[1]).toEqual({
    content: '![](/api/files/f2) /api/files/f10',
    attachments: ['f2'],
    revision: 1,
    copies: { f1: 'f2' },
  });
  expect(fetcher.mock.calls.filter(([path]) => path === '/api/nodes/n1/content').map((call) => (call[1] as RequestInit & { headers: Record<string, string> }).headers['x-idempotency-key'])).toEqual(['save', 'save']);
});
