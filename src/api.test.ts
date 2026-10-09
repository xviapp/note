import { afterEach, expect, it, vi } from 'vitest';
import { api, uncertainFailure } from './api';
import { isOffline, setOffline } from './connectivity';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setOffline(false);
});

it('releases stalled writes without retrying and allows an explicit retry with the same key', async () => {
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(controller.signal)
    .mockImplementation(() => new AbortController().signal);
  const fetcher = vi.fn().mockImplementationOnce((_path, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal!.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    controller.abort();
  })).mockResolvedValueOnce(Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetcher);
  setOffline(false);
  const error = await api('/api/site', 'PATCH', { name: '页间' }, 'same-operation').catch((reason) => reason);
  expect(error).toMatchObject({ status: 0, code: 'REQUEST_TIMEOUT' });
  expect(uncertainFailure(error)).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(timeout).toHaveBeenCalledWith(30_000);
  expect(isOffline()).toBe(false);
  await api('/api/site', 'PATCH', { name: '页间' }, 'same-operation');
  expect(fetcher.mock.calls.map((call) => call[1].headers['x-idempotency-key'])).toEqual(['same-operation', 'same-operation']);
});

it('allows long AI work to finish within its provider budget', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ prompt: '阅读助手' })));
  setOffline(false);
  await api('/api/books/role-prompt', 'POST', { title: '书籍' });
  expect(timeout).toHaveBeenCalledWith(25 * 60_000);
});
