import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Clip, ClipList } from '../../shared/clips';
import { QuickClips } from './QuickClips';
import { discardPending, flushClips } from '../clips';
import { ApiError } from '../api';

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../api', async (original) => ({
  ...await original<typeof import('../api')>(),
  api,
  cachedApi: async () => undefined,
}));
beforeEach(() => { localStorage.clear(); api.mockReset(); });
afterEach(() => { cleanup(); discardPending('restored'); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

it.each(['success', 'refresh failure', 'save failure'])(
  'keeps an undone clip visible throughout saving and refreshing: %s', async (result) => {
  const clip: Clip = {
    id: 'restored', text: '撤销后应持续显示', created_at: Date.now(),
    source_id: null, source_title: null, key_id: null, pinned: false, file: null,
  };
  const list: ClipList = { items: [clip], pinned: [], next: null, keyId: null };
  const post = deferred<Clip>();
  const refresh = deferred<ClipList>();
  let reads = 0;
  api.mockImplementation((path: string, method = 'GET') => {
    if (method === 'DELETE') return Promise.resolve({});
    if (method === 'POST') return post.promise;
    if (path === '/api/clips') return ++reads === 1 ? Promise.resolve(list) : refresh.promise;
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  render(<QuickClips source={null} onClose={() => {}} onNavigate={() => {}} onCreated={() => {}} />);
  await screen.findByText(clip.text);
  fireEvent.click(screen.getByRole('button', { name: '删除' }));
  await screen.findByRole('button', { name: '撤销' });
  expect(screen.queryByText(clip.text)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '撤销' }));
  await screen.findByText(clip.text);
  await act(async () => {
    if (result === 'save failure') post.reject(new ApiError('保存失败', 400));
    else post.resolve(clip);
    await flushClips();
  });
  const countBeforeRefresh = screen.queryAllByText(clip.text).length;
  if (result === 'refresh failure') {
    await act(async () => { refresh.reject(new Error('刷新失败')); });
    expect(screen.getByRole('alert').textContent).toBe('刷新失败');
  } else {
    await act(async () => { refresh.resolve(list); });
  }
  expect(screen.getAllByText(clip.text)).toHaveLength(1);
  expect(countBeforeRefresh).toBe(1);
  if (result === 'save failure') {
    expect(screen.getByRole('alert').textContent).toBe('保存失败');
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await act(async () => {});
    expect(screen.queryByText(clip.text)).toBeNull();
  } else {
    expect(screen.queryByText('正在保存')).toBeNull();
  }
});
