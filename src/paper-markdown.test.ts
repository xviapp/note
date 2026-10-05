import { describe, expect, it } from 'vitest';
import { paperMarkdown } from './paper-markdown';

const article = (html: string) => {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
};

describe('paperMarkdown', () => {
  it('writes headings, paragraphs with $TeX$, figures, equations, lists and table notes', () => {
    const markdown = paperMarkdown(
      article(`<section><h2>1 引言</h2>
        <div class="ltx_para"><p>能量是 <math alttext="E=mc^2"><mi>E</mi></math>，<em>很重要</em>。</p></div>
        <figure><img data-file-source="/api/files/abc-1" alt="图 [1]"><figcaption>图 1：示意图</figcaption></figure>
        <table class="ltx_equation"><tr><td><math alttext="a+b"><mi>a</mi></math></td></tr></table>
        <table class="ltx_tabular"><tr><td>1</td></tr></table>
        <ul><li>第一项</li><li>第二项</li></ul></section>`),
    );
    expect(markdown).toBe(
      [
        '## 1 引言',
        '能量是 $E=mc^2$，*很重要*。',
        '![图 1](/api/files/abc-1)',
        '*图 1：示意图*',
        '$$\na+b\n$$',
        '*（表格请在原论文中查看）*',
        '- 第一项',
        '- 第二项',
      ].join('\n\n') + '\n',
    );
  });

  it('links at most 100 different images', () => {
    const images = Array.from({ length: 102 }, (_, i) => `<img data-file-source="/api/files/f${i}">`);
    const markdown = paperMarkdown(article(images.join('')));
    expect(markdown.match(/\/api\/files\//g)).toHaveLength(100);
    expect(markdown).toContain('其余图片请在原论文中查看');
  });
});
