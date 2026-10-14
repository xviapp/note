import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OutboxSettings } from './OutboxSettings';
const { history } = vi.hoisted(() => ({ history: { items: [] as { id: string; summary: string; detail: string; sentAt: number }[] } }));
vi.mock('../outbox', () => ({ useOutbox: () => ({ groups: [], refresh: vi.fn() }) }));
vi.mock('../sent-history', () => ({ useSentHistory: () => history.items }));
afterEach(() => { cleanup(); history.items = []; });
it('shows history or pending content according to the route', () => {
  history.items = [{ id: 'one', summary: '晚饭后散步', detail: '今日记', sentAt: Date.now() }];
  const { rerender } = render(<OutboxSettings confirm={vi.fn()} onNavigate={vi.fn()} history />);
  expect(screen.queryByRole('heading')).toBeNull();
  expect(screen.getByText('晚饭后散步')).toBeTruthy();
  rerender(<OutboxSettings confirm={vi.fn()} onNavigate={vi.fn()} />);
  expect(screen.getByText('没有待发送的内容。')).toBeTruthy();
  expect(screen.queryByText('晚饭后散步')).toBeNull();
});
it('shows an explicit empty history', () => {
  render(<OutboxSettings confirm={vi.fn()} onNavigate={vi.fn()} history />);
  expect(screen.getByText('暂无发送记录')).toBeTruthy();
});
