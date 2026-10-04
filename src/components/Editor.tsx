import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView, keymap } from '@codemirror/view';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useTheme } from '../theme';
import { editorTheme } from '../editor-theme';

// Changes made from outside the editor while it is open.
export interface EditorHandle {
  // Inserts on its own line at the cursor (or where the cursor last was).
  insert: (text: string) => void;
  // Rewrites the whole text, e.g. to drop a removed attachment's image.
  transform: (change: (text: string) => string) => void;
}

// The editor owns its text once open: `value` is read only when it mounts, and
// every edit is reported through onChange. Feeding the value back would let a
// render that lags behind typing overwrite the newest keystrokes.
export default function Editor({
  value,
  onChange,
  onSave,
  onFiles,
  handleRef,
  kind,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  // Pasted or dropped files, uploaded like the file picker's.
  onFiles: (files: FileList) => void;
  handleRef: RefObject<EditorHandle | null>;
  kind: 'markdown' | 'text';
}) {
  const { theme } = useTheme();
  const view = useRef<EditorView | null>(null);
  const [initial] = useState(value);
  // The latest handlers, so the extensions stay the same across renders.
  const handlers = useRef({ onSave, onFiles });
  handlers.current = { onSave, onFiles };
  useEffect(() => {
    const insert = (text: string) => {
      const editor = view.current;
      if (!editor) return;
      const { from, to } = editor.state.selection.main;
      const line = editor.state.doc.lineAt(from);
      const before = from === line.from ? '' : '\n';
      const after = to === editor.state.doc.lineAt(to).to ? '' : '\n';
      const piece = `${before}${text}${after}`;
      editor.dispatch({
        changes: { from, to, insert: piece },
        selection: { anchor: from + piece.length },
        scrollIntoView: true,
      });
    };
    const transform = (change: (text: string) => string) => {
      const editor = view.current;
      if (!editor) return;
      const text = editor.state.doc.toString(),
        next = change(text);
      if (next !== text) editor.dispatch({ changes: { from: 0, to: text.length, insert: next } });
    };
    handleRef.current = { insert, transform };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef]);
  const extensions = useMemo(
    () => [
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({
        'aria-label': kind === 'markdown' ? 'Markdown 源码' : '纯文本正文',
      }),
      keymap.of([
        {
          key: 'Mod-s',
          run: () => {
            handlers.current.onSave();
            return true;
          },
        },
      ]),
      EditorView.domEventHandlers({
        paste(event) {
          const files = event.clipboardData?.files;
          if (!files?.length) return false;
          event.preventDefault();
          handlers.current.onFiles(files);
          return true;
        },
        drop(event, editor) {
          const files = event.dataTransfer?.files;
          if (!files?.length) return false;
          event.preventDefault();
          const position = editor.posAtCoords({ x: event.clientX, y: event.clientY });
          if (position !== null) editor.dispatch({ selection: { anchor: position } });
          handlers.current.onFiles(files);
          return true;
        },
      }),
      ...(kind === 'markdown' ? [markdown()] : []),
    ],
    [kind],
  );
  return (
    <CodeMirror
      value={initial}
      onChange={onChange}
      onCreateEditor={(editor) => {
        view.current = editor;
      }}
      extensions={extensions}
      height="100%"
      minHeight="350px"
      theme={editorTheme(theme)}
      autoFocus
      basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true }}
    />
  );
}
