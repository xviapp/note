import { indentLess, indentMore, redo, undo } from '@codemirror/commands';
import type { EditorState, TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import {
  Bold,
  Code,
  Heading,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Redo2,
  StickyNote,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { openClips } from '../clips';
import {
  cycleHeading,
  insertLink,
  toggleCode,
  toggleLineMarker,
  toggleWrap,
} from '../markdown-format';
import { useVisualViewport } from '../use-visual-viewport';

type Action = [label: string, Icon: LucideIcon, run: (view: EditorView) => void];

const format = (command: (state: EditorState) => TransactionSpec) => (view: EditorView) =>
  view.dispatch(view.state.update(command(view.state), { scrollIntoView: true, userEvent: 'input' }));

const MARKDOWN: Action[] = [
  ['标题', Heading, format(cycleHeading)],
  ['加粗', Bold, format((s) => toggleWrap(s, '**'))],
  ['斜体', Italic, format((s) => toggleWrap(s, '*'))],
  ['列表', List, format((s) => toggleLineMarker(s, 'bullet'))],
  ['编号列表', ListOrdered, format((s) => toggleLineMarker(s, 'ordered'))],
  ['待办', ListTodo, format((s) => toggleLineMarker(s, 'task'))],
  ['引用', Quote, format((s) => toggleLineMarker(s, 'quote'))],
  ['代码', Code, format(toggleCode)],
  ['链接', Link, format(insertLink)],
  ['减少缩进', IndentDecrease, indentLess],
  ['增加缩进', IndentIncrease, indentMore],
];
const CLIPS: Action = ['插入随手记', StickyNote, () => openClips()];
// Always in reach at the end, outside the scrolling part.
const HISTORY: Action[] = [
  ['撤销', Undo2, undo],
  ['重做', Redo2, redo],
];

// Touch screens have no shortcuts for Markdown syntax, so while the editor has
// focus this bar sits on top of the keyboard (the visual viewport's bottom).
export function FormatBar({ view, markdown }: { view: EditorView; markdown: boolean }) {
  const viewport = useVisualViewport();
  const button = ([label, Icon, run]: Action) => (
    <button
      key={label}
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        run(view);
        if (!view.hasFocus) view.focus();
      }}
    >
      <Icon size={19} aria-hidden="true" />
    </button>
  );
  return createPortal(
    <div
      className="format-bar"
      role="toolbar"
      aria-label="格式"
      style={{ top: viewport.y + viewport.height }}
      // Keeps the editor focused, so the keyboard stays open.
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="format-bar-scroll">{[...(markdown ? MARKDOWN : []), CLIPS].map(button)}</div>
      <div className="format-bar-history">{HISTORY.map(button)}</div>
    </div>,
    document.body,
  );
}
