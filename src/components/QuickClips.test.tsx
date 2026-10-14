import * as keyring from '../keyring';
import * as drafts from '../note-drafts';
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
    source_id: null, source_title: null, key_id: null, pinned: false, archived: false, file: null,
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

it('offers archive, undo, search through older archives, and restore', async () => {
  const clip: Clip = { id: 'archive-test', text: '整理完成的想法', key_id: null, source_id: null,
    source_title: null, pinned: false, archived: false, created_at: Date.now(), file: null };
  const older: Clip = { ...clip, id: 'older', text: '更早的归档', archived: true };
  api.mockImplementation(async (path: string, method = 'GET', body?: { archived: boolean }) => {
    if (method === 'PATCH') { clip.archived = body!.archived; return { ...clip }; }
    if (path.includes('before=')) return { items: [older], pinned: [], next: null, keyId: null };
    const archive = path.includes('view=archived');
    return { items: clip.archived === archive ? [{ ...clip }] : [], pinned: [], next: archive ? '1_older' : null, keyId: null };
  });
  render(<QuickClips source={null} onClose={() => {}} onNavigate={() => {}} onCreated={() => {}} />);
  await screen.findByText(clip.text);
  fireEvent.click(screen.getByRole('button', { name: '归档' }));
  await screen.findByRole('button', { name: '撤销' });
  expect(screen.queryByText(clip.text)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '撤销' }));
  await screen.findByText(clip.text);
  fireEvent.click(screen.getByRole('button', { name: '归档' }));
  await screen.findByRole('button', { name: '撤销' });
  fireEvent.click(screen.getByRole('button', { name: '已归档' }));
  await screen.findByText(clip.text);
  expect(screen.queryByRole('textbox', { name: '随手记内容' })).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: '搜索已归档' }), { target: { value: '更早' } });
  await screen.findByText(older.text);
  fireEvent.change(screen.getByRole('textbox', { name: '搜索已归档' }), { target: { value: '整理' } });
  fireEvent.click(screen.getByRole('button', { name: '恢复随手记' }));
  await screen.findByText('已恢复到随手记');
  fireEvent.click(screen.getByRole('button', { name: '返回随手记' }));
  await screen.findByText(clip.text);
});

it('keeps the compose draft encrypted while changing archive views', async () => {
  const unlocked = vi.spyOn(keyring, 'isUnlocked').mockReturnValue(true);
  const write = vi.spyOn(drafts, 'writeDraft').mockResolvedValue(true);
  const archive = deferred<ClipList>();
  api.mockImplementation(async (path: string) => path.includes('view=archived')
    ? archive.promise : { items: [], pinned: [], next: null, keyId: 'clip-key' });
  try {
    render(<QuickClips source={null} onClose={() => {}} onNavigate={() => {}} onCreated={() => {}} />);
    await act(async () => {});
    fireEvent.change(screen.getByRole('textbox', { name: '随手记内容' }), { target: { value: '未提交的秘密' } });
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '已归档' }));
    await act(async () => {});
    expect(write.mock.calls.length).toBeGreaterThan(0);
    expect(write.mock.calls.every((call) => call[2] === 'clip-key')).toBe(true);
    await act(async () => { archive.resolve({ items: [], pinned: [], next: null, keyId: 'clip-key' }); });
  } finally { unlocked.mockRestore(); write.mockRestore(); }
});

it('leaves a clip visible when archiving is refused', async () => {
  api.mockImplementation(async (_path: string, method = 'GET') => {
    if (method === 'PATCH') throw new Error('归档失败，请重试。');
    return { items: [{ id: 'failed', text: '仍需保留', created_at: Date.now(), key_id: null,
      source_id: null, source_title: null, pinned: false, archived: false, file: null }], pinned: [], next: null, keyId: null };
  });
  render(<QuickClips source={null} onClose={() => {}} onNavigate={() => {}} onCreated={() => {}} />);
  await screen.findByText('仍需保留');
  fireEvent.click(screen.getByRole('button', { name: '归档' }));
  await screen.findByText('归档失败，请重试。');
  expect(screen.getByText('仍需保留')).toBeTruthy();
});
