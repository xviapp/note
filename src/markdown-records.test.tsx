import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MarkdownView } from './components/MarkdownView';

afterEach(cleanup);
const view = (content: string, records?: 'issue' | 'todo' | 'journal') =>
  render(<MarkdownView content={content} onNavigate={() => {}} onImage={() => {}} records={records} />).container;

it('groups an issue thread into records, status events and a conclusion', () => {
  const root = view([
    '问题描述', '## 讨论',
    '### 2026-10-07 14:05', '先看缓存。',
    '### 2026-10-07 15:20 · 定位原因', '缓存键缺少版本。', '- 第一点',
    '### 2026-10-08 09:00 · 待处理 → 已关闭',
    '### 2026-10-08 10:00 · 已关闭 → 待处理',
    '### 2026-10-09 10:00 · 待处理 → 已关闭', '加上版本号后解决。',
    '## 附录', '不属于讨论',
  ].join('\n\n'), 'issue');
  const records = [...root.querySelectorAll('section.record')];
  expect(records).toHaveLength(5);
  expect(records[0].className).toContain('is-untitled');
  expect(records[1].querySelector('.record-title')!.textContent).toBe('定位原因');
  expect(records[1].querySelector('li')!.textContent).toBe('第一点');
  // Headings keep their full text for annotations and the outline.
  expect(records[1].querySelector('h3')!.textContent).toBe('2026-10-07 15:20 · 定位原因');
  expect(records[2].className).toContain('is-status');
  expect(records[3].className).toContain('is-status');
  expect(records[4].className).toContain('is-conclusion');
  expect(records[4].querySelector('h3')!.getAttribute('data-label')).toBe('结论');
  expect(root.querySelector('section.record:last-of-type + h2, h2:last-of-type')!.textContent).toBe('附录');
  expect([...root.querySelectorAll('section p')].map((p) => p.textContent)).not.toContain('不属于讨论');
});

it('recognizes records written before kinds', () => {
  const root = view('原文\n\n## 晚上\n\n> 2026-10-07 11:00:00 +08:00\n\n旧记录\n\n> 2026-10-07 12:00:00 +08:00\n\n无标题', 'todo');
  const records = root.querySelectorAll('section.record.is-legacy');
  expect(records).toHaveLength(2);
  expect(records[0].querySelector('h2')!.textContent).toBe('晚上');
  expect(records[1].textContent).toContain('无标题');
});

it('lays out a journal day by time and leaves other notes untouched', () => {
  const root = view('# 今天\n\n### 09:30 · 早饭\n\n粥\n\n### 21:00\n\n睡前', 'journal');
  expect([...root.querySelectorAll('section.record .record-time')].map((item) => item.textContent)).toEqual(['09:30', '21:00']);
  expect(root.firstElementChild!.className).toContain('records-journal');
  expect(view('### 09:30 · 早饭\n\n粥').querySelector('section.record')).toBeNull();
  // A dated heading is not a journal record, and an undated one is not an issue record.
  expect(view('### 2026-10-07 09:30', 'journal').querySelector('section.record')).toBeNull();
  expect(view('### 09:30', 'issue').querySelector('section.record')).toBeNull();
});

it('keeps records out of the outline', () => {
  const onHeadings = vi.fn();
  render(<MarkdownView content={'# 标题\n\n## 讨论\n\n### 2026-10-07 14:05 · 记录\n\n内容'} onNavigate={() => {}} onImage={() => {}} onHeadings={onHeadings} records="issue" />);
  expect(onHeadings.mock.lastCall![0].map((item: { title: string }) => item.title)).toEqual(['标题', '讨论']);
});

it('hides a leading title that repeats the page heading, outside the outline', () => {
  const onHeadings = vi.fn();
  const { container } = render(<MarkdownView content={'# 2026年10月7日 星期三\n\n## 早上\n\n# 2026年10月7日 星期三'} onNavigate={() => {}} onImage={() => {}} onHeadings={onHeadings} hideHeading="2026年10月7日 星期三" />);
  expect([...container.querySelectorAll('h1')].map((item) => item.className)).toEqual(['is-repeated-title', '']);
  expect(onHeadings.mock.lastCall![0].map((item: { title: string }) => item.title)).toEqual(['早上', '2026年10月7日 星期三']);
  // A different leading title stays.
  expect(view('# 读书日', undefined).querySelector('.is-repeated-title')).toBeNull();
});
