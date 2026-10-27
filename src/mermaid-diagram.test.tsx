import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MarkdownView } from './components/MarkdownView';
import { renderMermaid } from './mermaid';
import { setTheme } from './theme';

vi.mock('./mermaid', () => ({ renderMermaid: vi.fn() }));
const draw = vi.mocked(renderMermaid);
const content = '```mermaid\ngantt\n  dateFormat YYYY-MM-DD\n  任务 :2026-10-27, 3d\n```';
const props = { onNavigate: vi.fn(), onImage: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  setTheme('light');
  draw.mockResolvedValue('data:image/svg+xml,diagram');
});
afterEach(cleanup);

it('renders Mermaid fences in Markdown and assistant mode while preserving ordinary and inline code', async () => {
  const { container } = render(<MarkdownView {...props} safeImages content={content + '\n\n`mermaid`\n\n```js\nconst x = 1;\n```'} />);
  const image = await screen.findByRole('button', { name: 'Mermaid 图表' });
  expect(draw).toHaveBeenCalledWith('gantt\n  dateFormat YYYY-MM-DD\n  任务 :2026-10-27, 3d\n', false);
  expect(container.querySelector('pre code.language-js')?.textContent).toBe('const x = 1;\n');
  expect(container.querySelector('p > code')?.textContent).toBe('mermaid');
  expect(container.querySelector('pre img')).toBeNull();
  fireEvent.keyDown(image, { key: 'Enter' });
  expect(props.onImage).toHaveBeenCalledWith('data:image/svg+xml,diagram', 'Mermaid 图表');
});

it('preserves source on render failure and renders again after editing', async () => {
  draw.mockRejectedValueOnce(new Error('invalid syntax'));
  const view = render(<MarkdownView {...props} content={content} />);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('请检查 Mermaid 语法'));
  expect(view.container.querySelector('pre code')?.textContent).toContain('gantt');
  view.rerender(<MarkdownView {...props} content={'```mermaid\nflowchart LR\n A --> B\n```'} />);
  await screen.findByRole('button', { name: 'Mermaid 图表' });
  expect(screen.queryByRole('status')).toBeNull();
});

it('redraws for light, dark and starry themes and ignores an outdated result', async () => {
  let finish!: (image: string) => void;
  draw.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  render(<MarkdownView {...props} content={content} />);
  await waitFor(() => expect(draw).toHaveBeenCalledTimes(1));
  act(() => setTheme('dark'));
  await screen.findByRole('button', { name: 'Mermaid 图表' });
  expect(draw.mock.lastCall?.[1]).toBe(true);
  await act(async () => finish('data:image/svg+xml,obsolete'));
  expect(screen.getByRole('button', { name: 'Mermaid 图表' }).getAttribute('src')).toBe('data:image/svg+xml,diagram');
  act(() => setTheme('starry'));
  await waitFor(() => expect(draw).toHaveBeenCalledTimes(3));
  expect(draw.mock.lastCall?.[1]).toBe(true);
});
