import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MarkdownView } from './components/MarkdownView';
import type { SectionControls } from './components/MarkdownSection';
import { replaceSection, type MarkdownSection } from './markdown-sections';

afterEach(cleanup);
function view(content: string) {
  const onEdit = vi.fn();
  const controls: SectionControls = { disabled: false, activeStart: null, editor: null, onEdit, onDelete: vi.fn() };
  const result = render(<MarkdownView content={content} onNavigate={() => {}} onImage={() => {}} sections={controls} />);
  const section = (title: string) => {
    fireEvent.click(screen.getByRole('button', { name: `管理章节 ${title}` }));
    fireEvent.click(screen.getByRole('button', { name: '编辑本节' }));
    return onEdit.mock.lastCall![0] as MarkdownSection;
  };
  return { ...result, section, controls };
}

it('uses parsed heading levels and includes descendants while ignoring code, quotes and lists', () => {
  const content = '前言\n\n# 文档\n\n## 第一节\n\n正文\n\n### 子节\n\n```md\n## 代码里的标题\n```\n\n> ## 引用标题\n\n- 列表\n\n  ## 列表标题\n\n## 第二节\n\n结束\n';
  const { section } = view(content);
  const first = section('第一节');
  expect(first.children).toBe(1);
  expect(content.slice(first.start, first.end)).toBe(content.slice(content.indexOf('## 第一节'), content.indexOf('## 第二节')));
  expect(section('子节').end).toBe(first.end);
  expect(section('文档').end).toBe(content.length);
  expect(content.slice(section('前言').start, section('前言').end)).toBe('前言\n\n');
  expect(screen.queryByRole('button', { name: '管理章节 代码里的标题' })).toBeNull();
  expect(screen.queryByRole('button', { name: '管理章节 引用标题' })).toBeNull();
  expect(screen.queryByRole('button', { name: '管理章节 列表标题' })).toBeNull();
});

it('preserves metadata, CRLF, and every byte outside a Setext section', () => {
  const front = '---\r\ntitle: 标题\r\n---\r\n\r\n';
  const content = front + '前言\r\n\r\n第一节\r\n------\r\n\r\n正文\r\n\r\n## 第二节\r\n\r\n保留\r\n';
  const { section } = view(content);
  const first = section('第一节');
  expect(replaceSection(content, first, '## 新标题\r\n\r\n修改')).toBe(front + '前言\r\n\r\n## 新标题\r\n\r\n修改\r\n\r\n## 第二节\r\n\r\n保留\r\n');
  expect(replaceSection(content, first, '')).toBe(front + '前言\r\n\r\n## 第二节\r\n\r\n保留\r\n');
  const intro = section('前言');
  expect(replaceSection(content, intro, '')).toBe(front + content.slice(content.indexOf('第一节')));
});

it('keeps reading text and heading IDs unchanged when controls and a menu are shown', () => {
  const content = '# 标题\n\n一段 **文字**。\n\n## 后文\n\n结尾';
  const plain = render(<MarkdownView content={content} onNavigate={() => {}} onImage={() => {}} />);
  const text = plain.container.textContent;
  const ids = [...plain.container.querySelectorAll('h1,h2')].map((item) => item.id);
  plain.unmount();
  const quick = view(content);
  expect(quick.container.textContent).toBe(text);
  expect([...quick.container.querySelectorAll('h1,h2')].map((item) => item.id)).toEqual(ids);
  fireEvent.click(screen.getByRole('button', { name: '管理章节 后文' }));
  expect(screen.getByRole('button', { name: '删除本节' })).toBeTruthy();
  expect(quick.container.textContent).toBe(text);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('button', { name: '删除本节' })).toBeNull();
});

it('treats a heading-free body as a preamble and distinguishes repeated headings by offset', () => {
  const first = view('整篇没有标题。');
  expect(first.section('前言')).toMatchObject({ start: 0, end: '整篇没有标题。'.length, children: 0 });
  first.unmount();
  const duplicate = view('## 同名\n\n一\n\n## 同名\n\n二');
  const buttons = screen.getAllByRole('button', { name: '管理章节 同名' });
  fireEvent.click(buttons[1]);
  fireEvent.click(screen.getByRole('button', { name: '编辑本节' }));
  expect(duplicate.controls.onEdit).toHaveBeenCalledWith(expect.objectContaining({ start: '## 同名\n\n一\n\n'.length }));
});

it('includes leading indentation when editing or deleting a heading-free preamble', () => {
  const content = '    indented code\n\n## 正文\n\n保留';
  const { section } = view(content);
  const intro = section('前言');
  expect(intro.start).toBe(0);
  expect(replaceSection(content, intro, '')).toBe('## 正文\n\n保留');
});
