import { describe, expect, it } from 'vitest';
import { arxivOf, classifyShare, linkOf, looksLikeMarkdown } from './share-kind';
import type { IncomingShare } from './shared-import';

const id = '11111111-1111-4111-8111-111111111111';
const file = (name: string, mime: string, n = 1) => ({
  id: `2222222${n}-2222-4222-8222-222222222222`,
  name,
  mime,
  size: 10,
  path: `/__share/${id}/2222222${n}-2222-4222-8222-222222222222`,
});
const text = (value: string, title?: string): IncomingShare => ({
  id,
  title,
  text: value,
  files: [],
});

describe('share kinds', () => {
  it('recognizes arXiv papers by link or tag, with a short caption only', () => {
    expect(arxivOf('https://arxiv.org/pdf/2501.12948v2')).toMatchObject({
      id: '2501.12948v2',
      url: 'https://arxiv.org/abs/2501.12948v2',
    });
    expect(arxivOf('DeepSeek-R1 https://arxiv.org/abs/2501.12948')?.rest).toBe('DeepSeek-R1');
    expect(arxivOf('see arXiv:2501.12948 for details')?.id).toBe('2501.12948');
    expect(arxivOf('https://arxiv.org/abs/hep-th/9901001v1')?.id).toBe('hep-th/9901001v1');
    expect(arxivOf(`${'长文'.repeat(200)} https://arxiv.org/abs/2501.12948`)).toBeNull();
    expect(arxivOf('https://arxiv.org/list/cs.CL/recent')).toBeNull();
    expect(classifyShare(text('https://arxiv.org/abs/2501.12948', '论文'))).toEqual({
      kind: 'arxiv',
      title: '论文',
      url: 'https://arxiv.org/abs/2501.12948',
      arxivId: '2501.12948',
    });
  });
  it('turns a lone address, or one after its page title, into a link', () => {
    expect(linkOf('https://example.com/a?b=1')).toEqual({
      url: 'https://example.com/a?b=1',
      rest: '',
    });
    expect(linkOf('一篇文章 https://example.com/post')?.rest).toBe('一篇文章');
    expect(linkOf('two https://a.test and https://b.test')).toBeNull();
    expect(classifyShare(text('https://www.example.com/post'))).toMatchObject({
      kind: 'link',
      title: 'example.com',
    });
    expect(classifyShare(text('一篇文章\nhttps://example.com/post'))).toMatchObject({
      kind: 'link',
      title: '一篇文章',
      url: 'https://example.com/post',
    });
  });
  it('tells Markdown from plain text', () => {
    expect(looksLikeMarkdown('# 标题\n正文')).toBe(true);
    expect(looksLikeMarkdown('```js\nx\n```')).toBe(true);
    expect(looksLikeMarkdown('- 一\n- 二\n\n**重点**')).toBe(true);
    expect(looksLikeMarkdown('只有 **一处** 强调')).toBe(false);
    expect(looksLikeMarkdown('普通的一段话。\n第二行。')).toBe(false);
    expect(classifyShare(text('AI 回答\n\n# 阅读\n\n**答案**')).kind).toBe('markdown');
    expect(classifyShare(text('今天读到一句话。')).kind).toBe('text');
  });
  it('sorts files into PDF, images, text files and mixed batches', () => {
    const files = (...list: IncomingShare['files']): IncomingShare => ({ id, files: list });
    expect(classifyShare(files(file('论文.pdf', 'application/pdf')))).toEqual({
      kind: 'pdf',
      title: '论文',
    });
    expect(
      classifyShare(files(file('a.jpg', 'image/jpeg'), file('b.png', 'image/png', 2))).kind,
    ).toBe('image');
    expect(classifyShare(files(file('笔记.md', 'text/plain')))).toEqual({
      kind: 'markdown',
      title: '笔记',
    });
    expect(classifyShare(files(file('摘录.txt', 'text/plain'))).kind).toBe('text');
    expect(
      classifyShare(files(file('a.pdf', 'application/pdf'), file('b.png', 'image/png', 2))).kind,
    ).toBe('files');
  });
});
