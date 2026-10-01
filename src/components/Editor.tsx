import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView, keymap } from '@codemirror/view';
import { useMemo } from 'react';

export default function Editor({
  value,
  onChange,
  onSave,
  kind,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  kind: 'markdown' | 'text';
}) {
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
            onSave();
            return true;
          },
        },
      ]),
      ...(kind === 'markdown' ? [markdown()] : []),
    ],
    [kind, onSave],
  );
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      height="100%"
      minHeight="350px"
      theme="light"
      autoFocus
      basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true }}
    />
  );
}
