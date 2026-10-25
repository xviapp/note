import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { cycleHeading, insertLink, toggleCode, toggleLineMarker, toggleWrap } from './markdown-format';

// `|` marks the cursor; `«` and `»` mark a selection.
function state(text: string) {
  const anchor = text.includes('«') ? text.indexOf('«') : text.indexOf('|');
  const head = text.includes('»') ? text.indexOf('»') - 1 : anchor;
  return EditorState.create({
    doc: text.replace(/[|«»]/g, ''),
    selection: EditorSelection.range(anchor, head),
  });
}
function apply(text: string, command: (state: EditorState) => TransactionSpec) {
  const before = state(text);
  const next = before.update(command(before)).state;
  const { from, to } = next.selection.main;
  const doc = next.doc.toString();
  return from === to
    ? `${doc.slice(0, from)}|${doc.slice(from)}`
    : `${doc.slice(0, from)}«${doc.slice(from, to)}»${doc.slice(to)}`;
}

describe('markdown format', () => {
  it('cycles a heading through three levels and back to text', () => {
    expect(apply('标|题', cycleHeading)).toBe('# 标|题');
    expect(apply('# 标|题', cycleHeading)).toBe('## 标|题');
    expect(apply('## 标|题', cycleHeading)).toBe('### 标|题');
    expect(apply('### 标|题', cycleHeading)).toBe('标|题');
  });

  it('toggles list markers on every selected line and replaces other markers', () => {
    expect(apply('«一\n二»', (s) => toggleLineMarker(s, 'bullet'))).toBe('- «一\n- 二»');
    expect(apply('«- 一\n- 二»', (s) => toggleLineMarker(s, 'bullet'))).toBe('«一\n二»');
    expect(apply('«- 一\n二»', (s) => toggleLineMarker(s, 'ordered'))).toBe('«1. 一\n2. 二»');
    expect(apply('  - [x] 做|完', (s) => toggleLineMarker(s, 'bullet'))).toBe('  - 做|完');
    expect(apply('- 待|办', (s) => toggleLineMarker(s, 'task'))).toBe('- [ ] 待|办');
    expect(apply('- [ ] 待|办', (s) => toggleLineMarker(s, 'task'))).toBe('待|办');
    expect(apply('|', (s) => toggleLineMarker(s, 'quote'))).toBe('> |');
  });

  it('leaves out a line the selection only reaches the start of', () => {
    expect(apply('«一\n»二', (s) => toggleLineMarker(s, 'quote'))).toBe('> «一\n»二');
  });

  it('wraps and unwraps the selection', () => {
    expect(apply('a «粗» b', (s) => toggleWrap(s, '**'))).toBe('a **«粗»** b');
    expect(apply('a **«粗»** b', (s) => toggleWrap(s, '**'))).toBe('a «粗» b');
    expect(apply('a | b', (s) => toggleWrap(s, '*'))).toBe('a *|* b');
  });

  it('uses inline code on one line and a fence across lines', () => {
    expect(apply('«x»', toggleCode)).toBe('`«x»`');
    expect(apply('«a\nb»', toggleCode)).toBe('```\n«a\nb»\n```');
  });

  it('puts the cursor where the link still needs text', () => {
    expect(apply('«页间»', insertLink)).toBe('[页间](|)');
    expect(apply('|', insertLink)).toBe('[|]()');
  });
});
