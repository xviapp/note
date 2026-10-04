import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

// The editor follows the app's palette tokens, so light, dark and starry
// themes all match the page around it instead of CodeMirror's own themes.
const highlight = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--ink)', fontWeight: '600' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: 'var(--blue)' },
  { tag: [tags.monospace, tags.quote], color: 'var(--muted)' },
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: 'var(--muted)' },
]);
const themes = new Map<boolean, Extension>();
export function editorTheme(theme: string): Extension {
  const dark = theme !== 'light';
  if (!themes.has(dark))
    themes.set(dark, [
      EditorView.theme(
        {
          '&': { backgroundColor: 'var(--surface)', color: 'var(--ink)' },
          '.cm-content': { caretColor: 'var(--ink)' },
          '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ink)' },
          '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
            { backgroundColor: 'var(--selected)' },
          '.cm-foldPlaceholder': {
            backgroundColor: 'var(--surface-subtle)',
            border: '1px solid var(--line)',
            color: 'var(--muted)',
          },
        },
        { dark },
      ),
      syntaxHighlighting(highlight),
    ]);
  return themes.get(dark)!;
}
