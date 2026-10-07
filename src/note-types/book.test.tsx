import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { NoteDetail } from '../../shared/types';
import type { TypeContext } from './view';
import { useBookPageView } from './book';

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../api', () => ({ api, ApiError: class extends Error {} }));
afterEach(() => { cleanup(); api.mockReset(); });

function context(question: string): TypeContext {
  return {
    note: {
      id: 'page', kind: 'markdown', variant: 'book-page', title: '第 1 页',
      book: { title: '量子力学' },
      book_page: { summary: '波函数与测量。', questions: [question], discussions: [] },
    } as unknown as NoteDetail,
    editing: false, offline: false, refreshKey: 0, refresh: vi.fn(),
    onAppended: vi.fn(), setAppending: vi.fn(), appending: false,
    assistantOpen: false, openAssistant: vi.fn(), onOpen: vi.fn(), onNavigate: vi.fn(),
    onCreated: vi.fn(), onChanged: vi.fn(), onError: vi.fn(), confirm: vi.fn(),
  };
}

it('turns an existing reader preference suggestion into a request for explanation', async () => {
  const question = '在学习不确定性原理时，你更关心它的数学推导还是物理解释？';
  api.mockResolvedValue({ id: 'discussion' });
  const ctx = context(question);
  const { result } = renderHook(() => useBookPageView(ctx));
  render(result.current!.below);
  fireEvent.click(screen.getByRole('button', { name: question }));
  await waitFor(() => expect(ctx.openAssistant).toHaveBeenCalledOnce());
  expect(api).toHaveBeenCalledWith('/api/nodes/page/discussions', 'POST', { title: question });
  const content = result.current!.assistant!.initialPrompt!.content;
  expect(content).toContain(question);
  expect(content).toContain('请结合本页原文');
  expect(content).toContain('直接解释并比较');
  expect(content).not.toBe(question);
});

it('sends a manually entered question unchanged', async () => {
  api.mockResolvedValue({ id: 'discussion' });
  const ctx = context('波函数的物理含义是什么？');
  const { result } = renderHook(() => useBookPageView(ctx));
  render(result.current!.footer);
  fireEvent.change(screen.getByLabelText('就这一页提问'), { target: { value: '什么是波函数？' } });
  fireEvent.click(screen.getByRole('button', { name: '提问' }));
  await waitFor(() => expect(ctx.openAssistant).toHaveBeenCalledOnce());
  expect(result.current!.assistant!.initialPrompt).toEqual({ content: '什么是波函数？', quote: undefined });
});

it('reports a failed discussion creation without sending the suggestion', async () => {
  const error = new Error('连接中断');
  api.mockRejectedValue(error);
  const question = '波函数的物理含义是什么？';
  const ctx = context(question);
  const { result } = renderHook(() => useBookPageView(ctx));
  render(result.current!.below);
  fireEvent.click(screen.getByRole('button', { name: question }));
  await waitFor(() => expect(ctx.onError).toHaveBeenCalledWith(error));
  expect(ctx.openAssistant).not.toHaveBeenCalled();
  expect(result.current!.assistant!.initialPrompt).toBeUndefined();
});

it('does not send suggestions while offline', () => {
  const question = '波函数的物理含义是什么？';
  const ctx = { ...context(question), offline: true };
  const { result } = renderHook(() => useBookPageView(ctx));
  render(result.current!.below);
  fireEvent.click(screen.getByRole('button', { name: question }));
  expect(api).not.toHaveBeenCalled();
  expect(ctx.openAssistant).not.toHaveBeenCalled();
});
