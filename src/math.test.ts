import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMath from 'remark-math';
import { normalizeMathDelimiters } from './math';

function mathNodes(markdown: string) {
  const found: { type: string; value: string }[] = [];
  const walk = (node: { type: string; value?: string; children?: unknown[] }) => {
    if (node.type === 'inlineMath' || node.type === 'math') {
      found.push({ type: node.type, value: node.value ?? '' });
    }
    for (const child of node.children ?? []) walk(child as typeof node);
  };
  walk(unified().use(remarkParse).use(remarkMath).parse(normalizeMathDelimiters(markdown)));
  return found;
}

describe('normalizeMathDelimiters', () => {
  it('turns LaTeX delimiters into math without moving source offsets', () => {
    const source = '若 \\(r\\le 8\\)，则\n\n\\[\n\\boxed{21\\text{ 个}}\n\\]\n';
    const normalized = normalizeMathDelimiters(source);
    expect(normalized).toHaveLength(source.length);
    expect(mathNodes(source)).toEqual([
      { type: 'inlineMath', value: 'r\\le 8' },
      { type: 'math', value: '\\boxed{21\\text{ 个}}' },
    ]);
  });

  it('keeps adjacent inline formulas apart', () => {
    expect(mathNodes('\\(a\\)\\(b\\)')).toEqual([
      { type: 'inlineMath', value: 'a' },
      { type: 'inlineMath', value: 'b' },
    ]);
  });

  it('leaves code, escaped backslashes and plain brackets alone', () => {
    const source = [
      '`\\(x\\)` and ``a `\\[y=1\\]` b``',
      '',
      '```tex',
      '\\[ x^2 \\]',
      '```',
      '',
      '见 \\[1\\] 与 $a \\\\[2pt] b$',
      '',
      '\\(not',
      '',
      'closed\\)',
    ].join('\n');
    expect(normalizeMathDelimiters(source)).toBe(source);
  });
});
