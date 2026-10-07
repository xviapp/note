import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteNode } from '../shared/types';
import { ListingCacheContext, useNodeListing, type ListingCache } from './use-node-listing';

const { api, cachedApi } = vi.hoisted(() => ({
  api: vi.fn(),
  cachedApi: vi.fn(async (): Promise<unknown> => undefined),
}));
vi.mock('./api', () => ({ api, cachedApi }));

const node = (id: string) => ({ id, title: id }) as NoteNode;
// Two pages: the first ends at offset 1, the second finishes the folder.
function pages(prefix = '') {
  api.mockImplementation(async (path: string) =>
    path.includes('offset=1')
      ? { nodes: [node(`${prefix}b`)], nextOffset: null }
      : { nodes: [node(`${prefix}a`)], nextOffset: 1 },
  );
}
function setup(cache: ListingCache, query: string, refresh = 0) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ListingCacheContext.Provider value={cache}>{children}</ListingCacheContext.Provider>
  );
  return renderHook(({ query, refresh }) => useNodeListing(query, refresh), {
    wrapper,
    initialProps: { query, refresh },
  });
}
const ids = (result: { current: ReturnType<typeof useNodeListing> }) =>
  result.current.listing?.nodes.map((item) => item.id);

describe('useNodeListing', () => {
  beforeEach(() => {
    api.mockReset();
    cachedApi.mockReset();
    cachedApi.mockResolvedValue(undefined);
  });

  it('shows the device snapshot until the server answers on a cold start', async () => {
    cachedApi.mockResolvedValue({ nodes: [node('saved')], nextOffset: null });
    let answer!: (value: unknown) => void;
    api.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const view = setup(new Map(), 'parent=');
    await waitFor(() => expect(ids(view.result)).toEqual(['saved']));
    expect(cachedApi).toHaveBeenCalledWith('/api/nodes?parent=');
    expect(view.result.current.loading).toBe(true);
    await act(async () => answer({ nodes: [node('fresh')], nextOffset: null }));
    expect(ids(view.result)).toEqual(['fresh']);
    expect(view.result.current.loading).toBe(false);
  });

  it('never lets a late snapshot replace the server listing', async () => {
    let snapshot!: (value: unknown) => void;
    cachedApi.mockReturnValue(new Promise((resolve) => (snapshot = resolve)));
    api.mockResolvedValue({ nodes: [node('fresh')], nextOffset: null });
    const view = setup(new Map(), 'parent=');
    await waitFor(() => expect(ids(view.result)).toEqual(['fresh']));
    await act(async () => snapshot({ nodes: [node('saved')], nextOffset: null }));
    expect(ids(view.result)).toEqual(['fresh']);
  });

  it('shows a loaded listing on return without fetching it again', async () => {
    pages();
    const cache: ListingCache = new Map();
    const first = setup(cache, 'parent=');
    await waitFor(() => expect(ids(first.result)).toEqual(['a']));
    await act(() => first.result.current.more());
    expect(ids(first.result)).toEqual(['a', 'b']);
    first.unmount();
    api.mockClear();
    const again = setup(cache, 'parent=');
    expect(ids(again.result)).toEqual(['a', 'b']);
    expect(again.result.current.loading).toBe(false);
    expect(api).not.toHaveBeenCalled();
  });

  it('revalidates every loaded page when the library changes', async () => {
    pages();
    const cache: ListingCache = new Map();
    const view = setup(cache, 'parent=');
    await waitFor(() => expect(ids(view.result)).toEqual(['a']));
    await act(() => view.result.current.more());
    pages('new-');
    view.rerender({ query: 'parent=', refresh: 1 });
    await waitFor(() => expect(ids(view.result)).toEqual(['new-a', 'new-b']));
  });

  it('always revalidates recent visits while showing the saved list', async () => {
    api.mockResolvedValue({ nodes: [node('old')], nextOffset: null });
    const cache: ListingCache = new Map();
    const first = setup(cache, 'view=recent');
    await waitFor(() => expect(ids(first.result)).toEqual(['old']));
    first.unmount();
    api.mockResolvedValue({ nodes: [node('new')], nextOffset: null });
    const again = setup(cache, 'view=recent');
    expect(ids(again.result)).toEqual(['old']);
    await waitFor(() => expect(ids(again.result)).toEqual(['new']));
  });

  it('keeps "load more" working after switching to a cached listing mid-fetch', async () => {
    const cache: ListingCache = new Map([
      ['parent=b', { listing: { nodes: [node('b1')], nextOffset: 1 }, pages: 1, refresh: 0 }],
    ]);
    let release!: () => void;
    api.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ nodes: [node('a1')], nextOffset: null });
        }),
    );
    const view = setup(cache, 'parent=a');
    view.rerender({ query: 'parent=b', refresh: 0 });
    await act(async () => release());
    api.mockResolvedValue({ nodes: [node('b2')], nextOffset: null });
    await act(() => view.result.current.more());
    expect(ids(view.result)).toEqual(['b1', 'b2']);
  });

  it('does not let a view with fewer pages shrink the shared entry', async () => {
    pages();
    const cache: ListingCache = new Map();
    const page = setup(cache, 'parent=x');
    await waitFor(() => expect(ids(page.result)).toEqual(['a']));
    await act(() => page.result.current.more());
    expect(cache.get('parent=x')?.pages).toBe(2);
    // A second view of the same folder at the same revision only loads once more.
    const sidebar = setup(cache, 'parent=x', 0);
    expect(ids(sidebar.result)).toEqual(['a', 'b']);
    cache.set('parent=x', { ...cache.get('parent=x')!, refresh: -1 });
    sidebar.rerender({ query: 'parent=x', refresh: 0 });
    await waitFor(() => expect(sidebar.result.current.loading).toBe(false));
    expect(cache.get('parent=x')?.pages).toBe(2);
  });
});
