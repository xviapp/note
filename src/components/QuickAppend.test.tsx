import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QuickAppend } from './QuickAppend';
import { DRAFT_PREFIX } from '../note-drafts';

const { append } = vi.hoisted(() => ({ append: vi.fn() }));
vi.mock('../append-note', () => ({ createNoteAppender: () => append }));
beforeEach(() => { localStorage.clear(); append.mockReset(); });
afterEach(cleanup);

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
  append.mockRejectedValueOnce(new Error('连接中断')).mockResolvedValueOnce(undefined);
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

it('uses Ctrl+Enter to submit and ignores IME composition', async () => {
  append.mockResolvedValue(undefined);
  render(<QuickAppend id="day" disabled={false} onSaved={() => {}} />);
  const field = screen.getByLabelText('记录内容');
  await waitFor(() => expect((field as HTMLTextAreaElement).disabled).toBe(false));
  fireEvent.change(field, { target: { value: '内容' } });
  fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true, isComposing: true });
  expect(append).not.toHaveBeenCalled();
  fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });
  await waitFor(() => expect(append).toHaveBeenCalledWith('', '内容'));
});

it('restores the custom submission operation after an uncertain response and reopening', async () => {
  const submit = vi.fn().mockRejectedValueOnce(new Error('连接中断')).mockResolvedValueOnce(undefined);
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
