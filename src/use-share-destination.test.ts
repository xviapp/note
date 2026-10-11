import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useShareDestination } from './use-share-destination';

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('./api', () => ({ api }));
const saved = { parentId: 'books', breadcrumbs: [{ id: 'books', title: '书籍' }] };

describe('share destination', () => {
  beforeEach(() => api.mockReset());

  it('keeps a failed lookup unresolved until retry instead of silently using the root', async () => {
    api.mockRejectedValueOnce(new Error('网络中断')).mockResolvedValue(saved);
    const { result } = renderHook(() => useShareDestination('clip', true));
    await waitFor(() => expect(result.current.error).toBe('网络中断'));
    expect(result.current.destination).toBeNull();
    expect(api).toHaveBeenCalledTimes(1);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.parent).toBe('books'));
    expect(result.current.error).toBe('');
  });

  it('waits for connectivity and preserves a manually chosen root across reconnects', async () => {
    api.mockResolvedValue(saved);
    const { result, rerender } = renderHook(({ enabled }) => useShareDestination('share', enabled), {
      initialProps: { enabled: false },
    });
    expect(api).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.parent).toBe('books'));
    act(() => result.current.select(null, '根目录'));
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(result.current.destination).toMatchObject({ parentId: null, title: '根目录' });
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('ignores a late response from the previous incoming item', async () => {
    let resolveFirst!: (value: unknown) => void;
    api.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ parentId: null, breadcrumbs: [] });
    const { result, rerender } = renderHook(({ id }) => useShareDestination(id, true), {
      initialProps: { id: 'first' },
    });
    rerender({ id: 'second' });
    await waitFor(() => expect(result.current.destination?.title).toBe('根目录'));
    await act(async () => resolveFirst(saved));
    expect(result.current.destination).toMatchObject({ parentId: null, title: '根目录' });
  });

  it('clears the previous selection while loading the next incoming item', async () => {
    api.mockResolvedValueOnce(saved).mockReturnValueOnce(new Promise(() => {}));
    const { result, rerender } = renderHook(({ id }) => useShareDestination(id, true), {
      initialProps: { id: 'first' },
    });
    await waitFor(() => expect(result.current.parent).toBe('books'));
    act(() => result.current.select('other', '其他'));
    rerender({ id: 'second' });
    expect(result.current.destination).toBeNull();
  });
});
