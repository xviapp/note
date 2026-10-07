import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BookContents } from './BookPageView';

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../api', () => ({ api }));
afterEach(() => { cleanup(); api.mockReset(); });

it('marks the current page and navigates to another saved page', async () => {
  api.mockResolvedValue({ pages: [{ id: 'p1', title: '第 1 页', page: 1 }, { id: 'p2', title: '第 2 页', page: 2 }], others: [] });
  const navigate = vi.fn();
  render(<BookContents bookId="book" title="量子力学" current="p1" refresh={0} onNavigate={navigate} />);
  expect(api).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '书内目录' }));
  const current = await screen.findByRole('button', { name: /第 1 页/ });
  expect(current.getAttribute('aria-current')).toBe('page');
  fireEvent.click(screen.getByRole('button', { name: /第 2 页/ }));
  expect(navigate).toHaveBeenCalledWith('p2');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('allows a failed directory load to be retried and an empty book to be opened', async () => {
  api.mockRejectedValueOnce(new Error('无法连接')).mockResolvedValueOnce({ pages: [], others: [] });
  const navigate = vi.fn();
  render(<BookContents bookId="book" title="量子力学" current="p1" refresh={0} onNavigate={navigate} />);
  fireEvent.click(screen.getByRole('button', { name: '书内目录' }));
  expect((await screen.findByRole('alert')).textContent).toBe('无法连接');
  fireEvent.click(screen.getByRole('button', { name: '重试加载目录' }));
  await waitFor(() => expect(screen.getByText('还没有书页，可返回书籍添加页面。')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: '返回书籍' }));
  expect(navigate).toHaveBeenCalledWith('book');
});
