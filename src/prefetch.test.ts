import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NoteDetail } from '../shared/types';

// Sealed fields are opened by reveal(); here a "sealed:" prefix stands for one.
vi.mock('./encryption', async (original) => ({
  ...(await original<typeof import('./encryption')>()),
  reveal: async <T,>(value: T): Promise<T> =>
    JSON.parse(JSON.stringify(value).replaceAll('sealed:', 'plain:')) as T,
}));

const { fetchNoteAhead } = await import('./api');
const cache = await import('./offline-cache');
const detail = {
  id: 'n1', kind: 'markdown', title: '读书笔记', revision: 1, content: '', sealed: 'body',
  summary: 'sealed:摘要', attachments: [], breadcrumbs: [],
} as unknown as NoteDetail;

beforeEach(async () => {
  localStorage.clear();
  await cache.rememberResponse('/api/auth/status', { authenticated: true, initialized: true }, cache.cacheEpoch());
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await cache.clearPrivateCache();
});

it('caches a prefetched note as the server sent it, never its opened fields', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(detail)));
  expect(await fetchNoteAhead('n1')).toMatchObject({ summary: 'plain:摘要' });
  const kept = await cache.cachedNote('n1');
  expect(kept).toMatchObject({ summary: 'sealed:摘要', content: '' });
  expect(JSON.stringify(kept)).not.toContain('plain:');
});

it('does not refill the cache when it was cleared while the request was on its way', async () => {
  let answer!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))));
  const fetching = fetchNoteAhead('n1');
  await vi.waitFor(() => expect(answer).toBeDefined());
  await cache.clearRecentCache();
  answer(Response.json(detail));
  await fetching;
  expect(await cache.cachedNote('n1')).toBeUndefined();
});
