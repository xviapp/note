import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OutboxSettings } from './OutboxSettings';
const { history } = vi.hoisted(() => ({ history: { items: [] as { id: string; summary: string; detail: string; sentAt: number }[] } }));
vi.mock('../outbox', () => ({ useOutbox: () => ({ groups: [], refresh: vi.fn() }) }));
vi.mock('../sent-history', () => ({ useSentHistory: () => history.items }));
afterEach(() => { cleanup(); history.items = []; });
it('opens history from the header and returns to the pending list', () => {
  history.items = [{ id: 'one', summary: '晚饭后散步', detail: '今日记', sentAt: Date.now() }];
  render(<OutboxSettings confirm={vi.fn()} onNavigate={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '发送历史' }));
  expect(screen.getByRole('heading', { name: '已发送' })).toBeTruthy();
  expect(screen.getByText('晚饭后散步')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '返回待发送' }));
  expect(screen.getByRole('heading', { name: '待发送' })).toBeTruthy();
});
it('shows an explicit empty history', () => {
  render(<OutboxSettings confirm={vi.fn()} onNavigate={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '发送历史' }));
  expect(screen.getByText('暂无发送记录')).toBeTruthy();
});
