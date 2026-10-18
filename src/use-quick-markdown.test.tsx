import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useQuickMarkdown } from './use-quick-markdown';
import { ApiError } from './api';
import { DRAFT_PREFIX, sectionDraftId } from './note-drafts';
import type { NoteDetail } from '../shared/types';

const { write, pendingSave } = vi.hoisted(() => ({ write: vi.fn(), pendingSave: vi.fn() }));
vi.mock('./edit-section', () => ({ createSectionWriter: () => write }));
vi.mock('./save-outbox', () => ({ pendingSave, subscribeSaves: () => () => {} }));
const note = { id: 'note', kind: 'markdown', content: '## 一\n\n原文\n\n## 二\n\n保留', revision: 3, attachments: [] } as unknown as NoteDetail;
const section = { start: 0, end: note.content.indexOf('## 二'), title: '一', level: 2, children: 0 };
const confirm = vi.fn();
const onSaved = vi.fn();
const onNotice = vi.fn();
const draftKey = DRAFT_PREFIX + sectionDraftId('note');
function Harness({ disabled = false, detail = note }: { disabled?: boolean; detail?: NoteDetail }) {
  const quick = useQuickMarkdown({ id: 'note', note: detail, editing: false, disabled, appending: false,
    confirm, onActive: () => {}, onBusy: () => {}, onSaved, refresh: () => {}, onNotice });
  return <>
    {quick.menu}
    <button onClick={() => quick.controls?.onEdit(section)}>开始编辑</button>
    <button onClick={() => void quick.leave()}>离开页面</button>
    {quick.controls?.editor}
  </>;
}
beforeEach(() => {
  vi.clearAllMocks();
  write.mockReset();
  pendingSave.mockReset();
  localStorage.clear();
  confirm.mockResolvedValue(false);
});
afterEach(cleanup);
const field = () => screen.getByRole('textbox', { name: '章节 Markdown（含标题和子章节）' });
function edit() {
  fireEvent.click(screen.getByRole('button', { name: '开始编辑' }));
  fireEvent.change(field(), { target: { value: '## 一\n\n修改' } });
}

it.each([
  [null, true],
  ['true', true],
  ['false', false],
] as const)('uses preference %s with quick editing enabled=%s', (preference, enabled) => {
  if (preference !== null) localStorage.setItem('note:quick-edit:note', preference);
  render(<Harness />);
  expect(screen.getByRole('button', { name: enabled ? '关闭快捷编辑' : '开启快捷编辑' }).getAttribute('aria-pressed'))
    .toBe(String(enabled));
  fireEvent.click(screen.getByRole('button', { name: '开始编辑' }));
  expect(screen.queryByRole('textbox') !== null).toBe(enabled);
});

it('remembers an explicit opt-out and a later opt-in across reopening', async () => {
  const first = render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: '关闭快捷编辑' }));
  await screen.findByRole('button', { name: '开启快捷编辑' });
  expect(localStorage.getItem('note:quick-edit:note')).toBe('false');
  first.unmount();
  const second = render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: '开始编辑' }));
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '开启快捷编辑' }));
  await screen.findByRole('button', { name: '关闭快捷编辑' });
  expect(localStorage.getItem('note:quick-edit:note')).toBe('true');
  second.unmount();
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: '开始编辑' }));
  expect(field()).toBeTruthy();
});

it('keeps the default enabled when device preferences cannot be read', () => {
  const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
  try {
    render(<Harness />);
    expect(screen.getByRole('button', { name: '关闭快捷编辑' })).toBeTruthy();
  } finally {
    getItem.mockRestore();
  }
});

it('backs up a full recoverable draft and asks before discarding section edits', async () => {
  render(<Harness />);
  edit();
  await waitFor(() => expect(JSON.parse(localStorage.getItem(draftKey)!).content)
    .toBe('## 一\n\n修改\n\n## 二\n\n保留'));
  fireEvent.click(screen.getByRole('button', { name: '离开页面' }));
  await waitFor(() => expect(confirm).toHaveBeenCalled());
  expect(field()).toHaveProperty('value', '## 一\n\n修改');
  confirm.mockResolvedValue(true);
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  expect(localStorage.getItem(draftKey)).toBeNull();
});

it('keeps conflicting input editable and prevents another save from overwriting newer content', async () => {
  write.mockRejectedValue(new ApiError('版本冲突', 409, 'VERSION_CONFLICT'));
  render(<Harness />);
  edit();
  fireEvent.click(screen.getByRole('button', { name: '保存本节' }));
  await screen.findByText(/修改已保留/);
  expect(field()).toHaveProperty('value', '## 一\n\n修改');
  expect(field()).toHaveProperty('disabled', false);
  expect(screen.getByRole('button', { name: '保存本节' })).toHaveProperty('disabled', true);
  expect(write).toHaveBeenCalledTimes(1);
});

it('freezes an uncertain write, blocks leaving and clears the draft after explicit retry succeeds', async () => {
  write.mockRejectedValueOnce(new ApiError('连接超时', 0)).mockResolvedValueOnce(note);
  render(<Harness />);
  edit();
  fireEvent.click(screen.getByRole('button', { name: '保存本节' }));
  const retry = await screen.findByRole('button', { name: '重试保存' });
  expect(field()).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: '离开页面' }));
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith('保存结果尚未确认，请先重试本节保存。'));
  expect(confirm).not.toHaveBeenCalled();
  fireEvent.click(retry);
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(note));
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(localStorage.getItem(draftKey)).toBeNull();
});

it('disables section writes offline and omits the mode for project items, journals and book pages', () => {
  const harness = render(<Harness disabled />);
  fireEvent.click(screen.getByRole('button', { name: '开始编辑' }));
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByRole('button', { name: '关闭快捷编辑' })).toHaveProperty('disabled', true);
  for (const detail of [
    { ...note, project_category: 'note' as const },
    { ...note, journal_entry: { date: '2026-10-18' } } as NoteDetail,
    { ...note, variant: 'book-page' as const },
  ]) {
    harness.rerender(<Harness detail={detail} />);
    expect(screen.queryByRole('button', { name: '关闭快捷编辑' })).toBeNull();
  }
});

it('keeps the full editor draft separate and blocks section editing while a body save is pending', async () => {
  const fullDraftKey = DRAFT_PREFIX + 'note';
  localStorage.setItem(fullDraftKey, 'queued-full-body');
  const harness = render(<Harness />);
  edit();
  await waitFor(() => expect(localStorage.getItem(draftKey)).toContain('修改'));
  expect(localStorage.getItem(fullDraftKey)).toBe('queued-full-body');
  confirm.mockResolvedValue(true);
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  expect(localStorage.getItem(fullDraftKey)).toBe('queued-full-body');
  pendingSave.mockReturnValue({ id: 'note' });
  harness.rerender(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: '开始编辑' }));
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(localStorage.getItem(fullDraftKey)).toBe('queued-full-body');
});
