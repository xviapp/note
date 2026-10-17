import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AppErrorBoundary, AppErrorScreen } from './AppErrorBoundary';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.removeItem('note:error-test-draft');
});

it('renders the app until a child fails, then offers recovery without clearing drafts', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  localStorage.setItem('note:error-test-draft', '未同步的内容');
  function Child({ fail }: { fail: boolean }) {
    if (fail) throw new Error('无法显示笔记');
    return <p>笔记内容</p>;
  }
  const app = render(
    <AppErrorBoundary>
      <Child fail={false} />
    </AppErrorBoundary>,
  );
  expect(screen.getByText('笔记内容')).toBeTruthy();
  app.rerender(
    <AppErrorBoundary>
      <Child fail />
    </AppErrorBoundary>,
  );
  expect(screen.getByRole('heading', { name: '页面遇到问题' })).toBeTruthy();
  expect(screen.getByRole('link', { name: '回到首页' }).getAttribute('href')).toBe('/');
  const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
  fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
  expect(reload).toHaveBeenCalledOnce();
  expect(localStorage.getItem('note:error-test-draft')).toBe('未同步的内容');
});

it('copies the version and error details on request', async () => {
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  render(<AppErrorScreen error={new TypeError('页面加载失败')} />);
  fireEvent.click(screen.getByRole('button', { name: '复制错误信息' }));
  expect(await screen.findByRole('status')).toHaveProperty('textContent', '错误信息已复制。');
  expect(copy).toHaveBeenCalledWith(expect.stringMatching(/^页间 [\d.]+\nTypeError: 页面加载失败$/));
});

it('keeps error details available when clipboard access fails', async () => {
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
  render(<AppErrorScreen error="启动失败" />);
  fireEvent.click(screen.getByRole('button', { name: '复制错误信息' }));
  expect(await screen.findByRole('status')).toHaveProperty('textContent', '无法复制，请手动选择上方错误信息。');
  expect(screen.getByText(/启动失败/)).toBeTruthy();
});
