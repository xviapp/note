import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state';

// Markdown formatting for the phone format bar. Each command maps every
// selection range and returns one transaction, so undo takes it back in one step.

export type LineMarker = 'bullet' | 'ordered' | 'task' | 'quote';

// A list or quote marker at the start of a line, after its indentation.
const MARKER = /^(\s*)([-*+] \[[ xX]\] |[-*+] |\d+[.)] |> )?/;
const HEADING = /^(#{1,6}) /;

const markerOf = (kind: LineMarker, index: number) =>
  kind === 'bullet' ? '- ' : kind === 'ordered' ? `${index + 1}. ` : kind === 'task' ? '- [ ] ' : '> ';
const isKind = (kind: LineMarker, marker: string) =>
  kind === 'bullet'
    ? /^[-*+] $/.test(marker)
    : kind === 'ordered'
      ? /^\d+[.)] $/.test(marker)
      : kind === 'task'
        ? /^[-*+] \[[ xX]\] $/.test(marker)
        : marker === '> ';

// The lines a range touches; a range ending at a line's start leaves that line out.
function linesOf(state: EditorState, from: number, to: number) {
  const first = state.doc.lineAt(from).number;
  let last = state.doc.lineAt(to).number;
  if (to > from && state.doc.line(last).from === to) last--;
  const lines = [];
  for (let n = first; n <= last; n++) lines.push(state.doc.line(n));
  return lines;
}

function mapLines(
  state: EditorState,
  change: (text: string, index: number, all: string[]) => { from: number; to: number; insert: string } | null,
): TransactionSpec {
  return state.changeByRange((range) => {
    const lines = linesOf(state, range.from, range.to);
    const texts = lines.map((line) => line.text);
    const changes = state.changes(
      lines.flatMap((line, i) => {
        const edit = change(line.text, i, texts);
        return edit ? [{ from: line.from + edit.from, to: line.from + edit.to, insert: edit.insert }] : [];
      }),
    );
    return {
      changes,
      range: EditorSelection.range(changes.mapPos(range.anchor, 1), changes.mapPos(range.head, 1)),
    };
  });
}

// Sets the marker on every selected line, or removes it when all already have it.
export function toggleLineMarker(state: EditorState, kind: LineMarker): TransactionSpec {
  return mapLines(state, (text, index, all) => {
    const remove = all.every((line) => isKind(kind, MARKER.exec(line)![2] ?? ''));
    const [, indent, marker = ''] = MARKER.exec(text)!;
    const insert = remove ? '' : markerOf(kind, index);
    return marker === insert ? null : { from: indent.length, to: indent.length + marker.length, insert };
  });
}

// # → ## → ### → plain text.
export function cycleHeading(state: EditorState): TransactionSpec {
  return mapLines(state, (text) => {
    const level = HEADING.exec(text)?.[1].length ?? 0;
    const insert = level === 0 ? '# ' : level < 3 ? `${'#'.repeat(level + 1)} ` : '';
    return { from: 0, to: level ? level + 1 : 0, insert };
  });
}

// Wraps the selection in `mark`, or unwraps it when the mark already surrounds it.
export function toggleWrap(state: EditorState, mark: string): TransactionSpec {
  const size = mark.length;
  return state.changeByRange((range) => {
    const before = state.sliceDoc(range.from - size, range.from);
    const after = state.sliceDoc(range.to, range.to + size);
    if (before === mark && after === mark)
      return {
        changes: [
          { from: range.from - size, to: range.from },
          { from: range.to, to: range.to + size },
        ],
        range: EditorSelection.range(range.from - size, range.to - size),
      };
    return {
      changes: [
        { from: range.from, insert: mark },
        { from: range.to, insert: mark },
      ],
      range: EditorSelection.range(range.from + size, range.to + size),
    };
  });
}

// Inline code, or a fenced block when the selection spans lines.
export function toggleCode(state: EditorState): TransactionSpec {
  const { from, to } = state.selection.main;
  if (!state.sliceDoc(from, to).includes('\n')) return toggleWrap(state, '`');
  const start = state.doc.lineAt(from).from;
  const end = state.doc.lineAt(to).to;
  return {
    changes: [
      { from: start, insert: '```\n' },
      { from: end, insert: '\n```' },
    ],
    selection: EditorSelection.range(start + 4, end + 4),
  };
}

// [text](), with the cursor where the address goes, or in the brackets when empty.
export function insertLink(state: EditorState): TransactionSpec {
  return state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    const cursor = text ? range.from + text.length + 3 : range.from + 1;
    return {
      changes: { from: range.from, to: range.to, insert: `[${text}]()` },
      range: EditorSelection.cursor(cursor),
    };
  });
}
