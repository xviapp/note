import { describe, expect, it } from 'vitest';
import type { NoteNode } from '../shared/types.ts';
import { assignNames, fileSuffix, safeStem } from './names.ts';

const node = (id: string, title: string, kind: NoteNode['kind'] = 'markdown') =>
  ({ id, title, kind }) as NoteNode;
describe('safeStem', () => {
  it.each([
    ['a/b\\c', 'a_b_c'],
    ['../../etc/passwd', '___.._etc_passwd'],
    ['.claude', '_claude'],
    ['..', '__'],
    ['  ', '未命名'],
    ['结尾点...', '结尾点'],
    ['a\nb', 'a_b'],
    ['AGENTS', 'AGENTS_'],
    ['claude.local', 'claude.local_'],
    ['Gemini', 'Gemini_'],
    ['agents手册', 'agents手册'],
  ])('%s', (title, expected) => {
    expect(safeStem(title)).toBe(expected);
  });
  it('stays within a file name limit without splitting characters', () => {
    const stem = safeStem('页'.repeat(200));
    expect(Buffer.byteLength(stem)).toBeLessThanOrEqual(200);
    expect(stem).toBe('页'.repeat(66));
  });
});
describe('assignNames', () => {
  it('strips the suffix a title already carries', () => {
    const names = assignNames([node('a', '笔记.md'), node('b', '图.PNG', 'image'), node('c', 'v1.2')]);
    expect([...names.values()]).toEqual(['笔记', '图', 'v1.2']);
  });
  it('gives every sibling sharing a name its ID, whatever the order', () => {
    const one = assignNames([node('a', '同名'), node('b', '同名'), node('c', '其他')]);
    const two = assignNames([node('b', '同名'), node('a', '同名'), node('c', '其他')]);
    expect(one.get('a')).toBe('同名~a');
    expect(one.get('b')).toBe('同名~b');
    expect(one.get('c')).toBe('其他');
    expect(two.get('a')).toBe(one.get('a'));
  });
  it('treats names differing only by case or form as the same', () => {
    const names = assignNames([node('a', 'Readme'), node('b', 'README'), node('c', 'café'), node('d', 'café')]);
    expect(new Set(names.values()).size).toBe(4);
    expect(names.get('a')).toBe('Readme~a');
    expect(names.get('d')).toBe('café~d');
  });
});
describe('fileSuffix', () => {
  it('prefers the type, then a plain suffix on the name', () => {
    expect(fileSuffix('x.dat', 'image/png')).toBe('.png');
    expect(fileSuffix('Report.DOCX', 'application/x')).toBe('.docx');
    expect(fileSuffix('无后缀', 'application/x')).toBe('.bin');
    expect(fileSuffix('a.b/c d', 'application/x')).toBe('.bin');
  });
});
