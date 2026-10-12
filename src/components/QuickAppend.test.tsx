import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { QuickAppend } from './QuickAppend';
import { DRAFT_PREFIX } from '../note-drafts';
import { dropPhotos, pendingPhotos } from '../pending-photos';
import { ApiError } from '../api';

const { append, upload } = vi.hoisted(() => ({ append: vi.fn(), upload: vi.fn() }));
vi.mock('../append-note', () => ({ createNoteAppender: () => append }));
vi.mock('../api', async (original) => {
  const actual = await original<typeof import('../api')>();
  return { ...actual, upload };
});
vi.mock('./CachedImage', () => ({
  CachedImage: (props: ComponentProps<'img'>) => <img {...props} />,
}));
beforeEach(async () => { localStorage.clear(); append.mockReset(); upload.mockReset(); await dropPhotos(); });
afterEach(cleanup);

it('keeps typing open while a photo uploads and offers retry after a failure', async () => {
  let rejectUpload!: (reason: Error) => void;
  upload.mockImplementation(() => new Promise((_, reject) => { rejectUpload = reject; }));
  render(<QuickAppend id="day" disabled={false} onSaved={() => {}} />);
  await waitFor(() => expect((screen.getByLabelText('添加照片') as HTMLInputElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('添加照片'), {
    target: { files: [new File(['image'], '照片.png', { type: 'image/png' })] },
  });
  expect((await screen.findByRole('status')).textContent).toContain('正在上传 1 张照片');
  expect((screen.getByLabelText('记录内容') as HTMLTextAreaElement).disabled).toBe(false);
  expect((screen.getByRole('button', { name: '追加' }) as HTMLButtonElement).disabled).toBe(false);
  rejectUpload(new Error('连接中断'));
  expect((await screen.findByRole('alert')).textContent).toContain('没传上去');
  expect(screen.queryByRole('status')).toBeNull();
  upload.mockResolvedValueOnce({ id: 'photo', name: '照片.png', mime: 'image/png', size: 5 });
  fireEvent.click(screen.getByRole('button', { name: '重试上传 照片.png' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(await pendingPhotos('append:day')).toEqual([]);
});

it('saves once photos finish uploading, and a save cut off resumes on reopening', async () => {
  let finish!: (file: unknown) => void;
  upload.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const submit = vi.fn().mockResolvedValue(undefined);
  const saved = vi.fn();
  const submitted = vi.fn();
  const view = render(<QuickAppend id="day" disabled={false} onAppend={submit} onSubmit={submitted} onSaved={saved} />);
  await waitFor(() => expect((screen.getByLabelText('添加照片') as HTMLInputElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('添加照片'), {
    target: { files: [new File(['image'], '雨.png', { type: 'image/png' })] },
  });
  await screen.findByRole('status');
  fireEvent.change(screen.getByLabelText('记录内容'), { target: { value: '下雨了' } });
  fireEvent.click(screen.getByRole('button', { name: '追加' }));
  expect(submitted).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: '保存中…' })).toBeTruthy();
  expect(submit).not.toHaveBeenCalled();
  // The window closes (or Android ends the app) before the photo is up.
  await waitFor(() =>
    expect(JSON.parse(JSON.parse(localStorage.getItem(`${DRAFT_PREFIX}append:day`)!).content).queued).toBe(true));
  view.unmount();
  upload.mockResolvedValue({ id: 'rain', name: '雨.png', mime: 'image/png', size: 5 });
  render(<QuickAppend id="day" disabled={false} onAppend={submit} onSaved={saved} />);
  await waitFor(() => expect(saved).toHaveBeenCalledWith({ resumed: true }));
  expect(submit).toHaveBeenCalledWith('', '下雨了\n\n![雨.png](/api/files/rain)', expect.any(String), ['rain']);
  expect(await pendingPhotos('append:day')).toEqual([]);
  finish(undefined);
});

it('shows submit on focus or input and keeps it available when focus moves to the button', async () => {
  render(<QuickAppend id="day" disabled={false} onSaved={() => {}} />);
  const title = screen.getByLabelText('记录标题');
  const field = screen.getByLabelText('记录内容');
  await waitFor(() => expect((field as HTMLTextAreaElement).disabled).toBe(false));
  expect(screen.queryByRole('button', { name: '追加' })).toBeNull();
  fireEvent.focus(title);
  expect(screen.getByRole('button', { name: '追加' })).toBeTruthy();
  fireEvent.blur(title, { relatedTarget: document.body });
  expect(screen.queryByRole('button', { name: '追加' })).toBeNull();
  fireEvent.change(field, { target: { value: '一条记录' } });
  expect(screen.getByRole('button', { name: '追加' })).toBeTruthy();
  fireEvent.focus(field);
  fireEvent.blur(field, { relatedTarget: screen.getByRole('button', { name: '追加' }) });
  fireEvent.change(field, { target: { value: '' } });
  expect(screen.getByRole('button', { name: '追加' })).toBeTruthy();
  fireEvent.blur(screen.getByRole('button', { name: '追加' }), { relatedTarget: document.body });
  expect(screen.queryByRole('button', { name: '追加' })).toBeNull();
});

it('keeps offline input on the device and restores it on reopening', async () => {
  const view = render(<QuickAppend id="day" disabled onSaved={() => {}} />);
  await waitFor(() => expect((screen.getByLabelText('记录内容') as HTMLTextAreaElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('记录标题'), { target: { value: '散步' } });
  fireEvent.change(screen.getByLabelText('记录内容'), { target: { value: '路边的猫' } });
  expect((screen.getByRole('button', { name: '追加' }) as HTMLButtonElement).disabled).toBe(true);
  await waitFor(() => expect(localStorage.getItem(`${DRAFT_PREFIX}append:day`)).toContain('路边的猫'));
  view.unmount();
  render(<QuickAppend id="day" disabled={false} onSaved={() => {}} />);
  await waitFor(() => expect((screen.getByLabelText('记录内容') as HTMLTextAreaElement).value).toBe('路边的猫'));
  expect((screen.getByLabelText('记录标题') as HTMLInputElement).value).toBe('散步');
});

it('keeps a failed submission intact until retry succeeds', async () => {
  append.mockRejectedValueOnce(new ApiError('连接已中断，请联网后重试。', 0, 'OFFLINE')).mockResolvedValueOnce(undefined);
  const saved = vi.fn();
  render(<QuickAppend id="day" disabled={false} onSaved={saved} />);
  await waitFor(() => expect((screen.getByLabelText('记录内容') as HTMLTextAreaElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('记录内容'), { target: { value: '内容' } });
  fireEvent.click(screen.getByRole('button', { name: '追加' }));
  await screen.findByRole('alert');
  expect((screen.getByLabelText('记录内容') as HTMLTextAreaElement).value).toBe('内容');
  expect(saved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '重试追加' }));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  expect((screen.getByLabelText('记录内容') as HTMLTextAreaElement).value).toBe('');
  expect(localStorage.getItem(`${DRAFT_PREFIX}append:day`)).toBeNull();
});

it('leaves the input editable after a definite failure', async () => {
  append.mockRejectedValueOnce(new ApiError('请先解锁这篇笔记。', 403)).mockResolvedValueOnce(undefined);
  render(<QuickAppend id="day" disabled={false} onSaved={() => {}} />);
  const field = screen.getByLabelText('记录内容') as HTMLTextAreaElement;
  await waitFor(() => expect(field.disabled).toBe(false));
  fireEvent.change(field, { target: { value: '内容' } });
  fireEvent.click(screen.getByRole('button', { name: '追加' }));
  await screen.findByRole('alert');
  expect(field.disabled).toBe(false);
  fireEvent.change(field, { target: { value: '改过的内容' } });
  fireEvent.click(screen.getByRole('button', { name: '追加' }));
  await waitFor(() => expect(append).toHaveBeenLastCalledWith('', '改过的内容', expect.any(String)));
});

it('uses Ctrl+Enter to submit and ignores IME composition', async () => {
  append.mockResolvedValue(undefined);
  render(<QuickAppend id="day" disabled={false} onSaved={() => {}} />);
  const field = screen.getByLabelText('记录内容');
  await waitFor(() => expect((field as HTMLTextAreaElement).disabled).toBe(false));
  fireEvent.change(field, { target: { value: '内容' } });
  fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true, isComposing: true });
  expect(append).not.toHaveBeenCalled();
  fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });
  await waitFor(() => expect(append).toHaveBeenCalledWith('', '内容', expect.any(String)));
});

it('restores the custom submission operation after an uncertain response and reopening', async () => {
  const submit = vi.fn().mockRejectedValueOnce(new ApiError('连接已中断，请联网后重试。', 0, 'OFFLINE')).mockResolvedValueOnce(undefined);
  const saved = vi.fn();
  const view = render(<QuickAppend id="journal:book:day" disabled={false} onAppend={submit} onSaved={saved} />);
  const field = screen.getByLabelText('记录内容');
  await waitFor(() => expect((field as HTMLTextAreaElement).disabled).toBe(false));
  fireEvent.change(field, { target: { value: '第一条记录' } });
  fireEvent.click(screen.getByRole('button', { name: '追加' }));
  await screen.findByRole('alert');
  const first = submit.mock.calls[0];
  view.unmount();
  render(<QuickAppend id="journal:book:day" disabled={false} onAppend={submit} onSaved={saved} />);
  const retry = await screen.findByRole('button', { name: '重试追加' });
  expect((screen.getByLabelText('记录内容') as HTMLTextAreaElement).value).toBe('第一条记录');
  fireEvent.click(retry);
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  expect(submit.mock.calls[1]).toEqual(first);
  expect(append).not.toHaveBeenCalled();
  expect(localStorage.getItem(`${DRAFT_PREFIX}append:journal:book:day`)).toBeNull();
});

it('uploads selected photos and appends their links and attachment ids', async () => {
  upload.mockResolvedValue({ id: 'photo', name: '散步.png', mime: 'image/png', size: 4 });
  const submit = vi.fn().mockResolvedValue(undefined);
  render(<QuickAppend id="day" disabled={false} onAppend={submit} onSaved={() => {}} />);
  const field = screen.getByLabelText('记录内容');
  await waitFor(() => expect((field as HTMLTextAreaElement).disabled).toBe(false));
  fireEvent.focus(field);
  const photo = new File([new Uint8Array([1, 2, 3, 4])], '散步.png', { type: 'image/png' });
  fireEvent.change(screen.getByLabelText('添加照片'), { target: { files: [photo] } });
  await waitFor(() => expect(upload).toHaveBeenCalledWith(photo, 'day'));
  expect(screen.getByAltText('散步.png')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '追加' }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(submit).toHaveBeenCalledWith('', '![散步.png](/api/files/photo)', expect.any(String), ['photo']);
});
