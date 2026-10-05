import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ANNOTATION_QUOTE_CHARS } from '../shared/annotations';
import type { SourceLocation } from '../shared/translation';
import {
  annotationAt,
  clearAnnotationHighlights,
  lastColor,
  paintAnnotations,
  rememberColor,
  sameLocation,
  type AnnotationStore,
} from './annotations';
import { AnnotationEditor, type AnnotationDraft } from './components/AnnotationDialogs';

// Highlights and notes over one rendered text: painting, opening one by
// clicking it, adding one from the selection toolbar, and its editor.
export function useAnnotationLayer({
  store,
  owner,
  root,
  active,
  offline,
  paintKey,
  outside = '这里的文字不能批注，请选择正文内容。',
  onAsk,
}: {
  store: AnnotationStore;
  // Names this view's highlights, which other views leave alone.
  owner: string;
  // The `.read-content` element the saved locations refer to.
  root: () => HTMLElement | null;
  active: boolean;
  offline: boolean;
  // Changes when the text is rendered anew.
  paintKey?: unknown;
  // Shown for a selection outside the text, e.g. the translated side.
  outside?: string;
  onAsk: (text: string) => string | undefined;
}) {
  const [draft, setDraft] = useState<AnnotationDraft | null>(null);
  const ranges = useRef(new Map<string, Range>());
  const [missingKey, setMissingKey] = useState('');
  const list = store.list;
  const findRoot = useRef(root);
  findRoot.current = root;
  useEffect(() => {
    const element = findRoot.current();
    ranges.current = new Map();
    if (!element || !active || !list.length) {
      clearAnnotationHighlights(owner);
      setMissingKey('');
      return;
    }
    let timer = 0;
    const paint = () => {
      const found = paintAnnotations(owner, element, list);
      ranges.current = found;
      setMissingKey(
        list
          .filter((item) => item.location.kind === 'text' && !found.has(item.id))
          .map((item) => item.id)
          .join(','),
      );
    };
    paint();
    // Formulas, paper figures and lazy Markdown render after the first paint.
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(paint, 150);
    });
    observer.observe(element, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
      clearAnnotationHighlights(owner);
    };
  }, [list, active, owner, paintKey]);
  const missingText = useMemo(() => new Set(missingKey.split(',').filter(Boolean)), [missingKey]);

  const open = (id: string) => {
    const item = list.find((annotation) => annotation.id === id);
    if (item) setDraft({ ...item, saved: true });
  };
  const annotate = async (
    { quote, location }: { quote: string; location: SourceLocation | null },
    withNote: boolean,
  ) => {
    if (offline) return '离线时不能添加批注。';
    if (!location) return outside;
    if (quote.length > ANNOTATION_QUOTE_CHARS)
      return `每条批注最多选择 ${ANNOTATION_QUOTE_CHARS.toLocaleString()} 个字符，请缩小范围。`;
    const existing = list.find((item) => sameLocation(item.location, location));
    if (existing) {
      setDraft({ ...existing, saved: true });
      return;
    }
    const next = {
      id: crypto.randomUUID(),
      quote,
      note: '',
      color: lastColor(),
      location,
      saved: false,
    };
    if (withNote) {
      setDraft(next);
      return;
    }
    try {
      await store.save(next);
    } catch (e) {
      return `未能高亮：${(e as Error).message}`;
    }
  };
  const onClick = (event: MouseEvent) => {
    if (!active || !ranges.current.size || !window.getSelection()?.isCollapsed) return;
    if ((event.target as Element).closest('a, button, input, textarea, img, summary')) return;
    const hit = annotationAt(ranges.current, event.clientX, event.clientY);
    if (hit) open(hit);
  };
  const editor =
    draft && active ? (
      <AnnotationEditor
        key={draft.id}
        draft={draft}
        offline={offline}
        onSave={(note, color) => {
          rememberColor(color);
          return store.save({ ...draft, note, color });
        }}
        onDelete={() => store.remove(draft.id)}
        onAsk={(note) =>
          onAsk(note.trim() ? `${draft.quote}\n\n（我的批注：${note.trim()}）` : draft.quote)
        }
        onClose={() => setDraft(null)}
      />
    ) : null;
  return { annotate, onClick, open, editor, missingText, setDraft };
}
