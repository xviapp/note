import { describe, expect, it } from 'vitest';
import { diffLines } from './line-diff';

describe('diffLines', () => {
  it('returns empty rows when both texts match', () => {
    expect(diffLines('第一行\n第二行', '第一行\n第二行')).toEqual([]);
  });

  it('marks added and deleted lines and collapses distant unchanged context', () => {
    const before = ['h1', 'c1', 'c2', 'c3', 'c4', 'c5', 'old line', 'tail1', 'tail2'].join('\n');
    const after = ['h1', 'c1', 'c2', 'c3', 'c4', 'c5', 'new line', 'extra', 'tail1', 'tail2'].join('\n');
    const rows = diffLines(before, after);
    expect(rows[0]).toEqual({ type: 'skip', count: 3 });
    expect(rows.filter((row) => row.type === 'del')).toEqual([
      { type: 'del', oldNumber: 7, text: 'old line' },
    ]);
    expect(rows.filter((row) => row.type === 'add')).toEqual([
      { type: 'add', newNumber: 7, text: 'new line' },
      { type: 'add', newNumber: 8, text: 'extra' },
    ]);
  });

  it('normalizes CRLF before comparing lines', () => {
    expect(diffLines('a\r\nb', 'a\nb')).toEqual([]);
  });
});
