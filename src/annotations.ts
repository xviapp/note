import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import {
  ANNOTATION_COLORS,
  annotationOrder,
  colorOf,
  isAnnotationColor,
  type Annotation,
  type AnnotationColor,
  type AnnotationList,
} from '../shared/annotations';
import type { SourceLocation } from '../shared/translation';
import { saveChildNote } from './child-note';
import { textSourceRange } from './source-location';

// Every open view of a file (the page, a full-screen view) shares saves.
const CHANGED = 'annotations:changed';
type Changed = CustomEvent<{ nodeId: string; list: Annotation[] }>;

// One file's highlights and notes, loaded when the file opens. Changes are
// saved one annotation at a time and the server answers with the whole list.
export function useAnnotations(nodeId: string | undefined, enabled: boolean) {
  const [list, setList] = useState<Annotation[]>([]),
    [error, setError] = useState('');
  const current = useRef(nodeId);
  current.current = nodeId;
  useEffect(() => {
    setList([]);
    setError('');
    if (!enabled || !nodeId) return;
    let live = true;
    api<AnnotationList>(`/api/nodes/${nodeId}/annotations`)
      .then((result) => {
        if (live) setList(result.annotations);
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      });
    const changed = (event: Event) => {
      const detail = (event as Changed).detail;
      if (detail.nodeId === nodeId) setList(detail.list);
    };
    window.addEventListener(CHANGED, changed);
    return () => {
      live = false;
      window.removeEventListener(CHANGED, changed);
    };
  }, [nodeId, enabled]);
  const apply = (id: string, result: AnnotationList) =>
    window.dispatchEvent(
      new CustomEvent(CHANGED, { detail: { nodeId: id, list: result.annotations } }),
    );
  const save = useCallback(
    async (annotation: Pick<Annotation, 'id' | 'quote' | 'note' | 'location' | 'color'>) => {
      const id = current.current;
      if (!id) return;
      apply(
        id,
        await api<AnnotationList>(`/api/nodes/${id}/annotations/${annotation.id}`, 'PUT', {
          quote: annotation.quote,
          note: annotation.note,
          color: colorOf(annotation),
          location: annotation.location,
        }),
      );
    },
    [],
  );
  const remove = useCallback(async (annotationId: string) => {
    const id = current.current;
    if (!id) return;
    apply(id, await api<AnnotationList>(`/api/nodes/${id}/annotations/${annotationId}`, 'DELETE'));
  }, []);
  return { nodeId, list, error, save, remove };
}
export type AnnotationStore = ReturnType<typeof useAnnotations>;

// The colour a plain highlight uses: the one last picked.
const COLOR_KEY = 'annotation-color';
export function lastColor(): AnnotationColor {
  try {
    const value = localStorage.getItem(COLOR_KEY);
    return isAnnotationColor(value) ? value : 'yellow';
  } catch {
    return 'yellow';
  }
}
export function rememberColor(color: AnnotationColor) {
  try {
    localStorage.setItem(COLOR_KEY, color);
  } catch {
    /* Storage can be unavailable; the colour still applies now. */
  }
}

// A search result opens its file, then this annotation.
let pending: { nodeId: string; id: string } | null = null;
export function requestAnnotation(nodeId: string, id: string) {
  pending = { nodeId, id };
}
export function takeRequestedAnnotation(nodeId: string) {
  if (pending?.nodeId !== nodeId) return null;
  const id = pending.id;
  pending = null;
  return id;
}

// The same selection again, which opens its annotation instead of adding one.
export const sameLocation = (a: SourceLocation, b: SourceLocation) =>
  a.kind === 'text' && b.kind === 'text'
    ? a.start === b.start && a.end === b.end && a.exact === b.exact
    : a.kind === 'pdf' &&
      b.kind === 'pdf' &&
      a.fileId === b.fileId &&
      JSON.stringify(a.rects) === JSON.stringify(b.rects);

// CSS highlights are global, so each view paints into its own layer and the
// registered highlights are the union of all layers.
const layers = new Map<string, Map<string, Range[]>>();
const highlightName = (annotation: Annotation) =>
  `annotation-${colorOf(annotation)}${annotation.note ? '-note' : ''}`;
function publish() {
  if (typeof Highlight === 'undefined' || !CSS.highlights) return;
  const names = new Map<string, Range[]>();
  for (const layer of layers.values())
    for (const [name, ranges] of layer) names.set(name, [...(names.get(name) ?? []), ...ranges]);
  for (const color of Object.keys(ANNOTATION_COLORS))
    for (const name of [`annotation-${color}`, `annotation-${color}-note`]) {
      const ranges = names.get(name);
      if (ranges?.length) CSS.highlights.set(name, new Highlight(...ranges));
      else CSS.highlights.delete(name);
    }
}
export function clearAnnotationHighlights(owner: string) {
  if (layers.delete(owner)) publish();
}

// Paints the annotations that can still be found in the text. Returns their
// ranges for hit testing; the rest are listed as no longer locatable.
export function paintAnnotations(owner: string, root: HTMLElement, list: Annotation[]) {
  const ranges = new Map<string, Range>();
  const layer = new Map<string, Range[]>();
  const text = root.textContent || '';
  for (const annotation of list) {
    if (annotation.location.kind !== 'text') continue;
    const range = textSourceRange(root, annotation.location, text);
    if (typeof range === 'string') continue;
    ranges.set(annotation.id, range);
    const name = highlightName(annotation);
    layer.set(name, [...(layer.get(name) ?? []), range]);
  }
  layers.set(owner, layer);
  publish();
  return ranges;
}

// The annotation under a click, the shortest when several overlap.
export function annotationAt(ranges: Map<string, Range>, x: number, y: number) {
  const caret = document.caretPositionFromPoint?.(x, y);
  const point = caret
    ? { node: caret.offsetNode, offset: caret.offset }
    : (() => {
        const range = document.caretRangeFromPoint?.(x, y);
        return range ? { node: range.startContainer, offset: range.startOffset } : null;
      })();
  if (!point) return null;
  let found: string | null = null,
    length = Infinity;
  for (const [id, range] of ranges) {
    // A caret at the very end lies just after the highlighted text.
    if (range.endContainer === point.node && range.endOffset === point.offset) continue;
    try {
      if (range.comparePoint(point.node, point.offset) !== 0) continue;
    } catch {
      continue;
    }
    const size = range.toString().length;
    if (size < length) {
      found = id;
      length = size;
    }
  }
  return found;
}

const quoteBlock = (text: string) =>
  text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

// Saves every highlight and note of a file as one Markdown child note, in
// reading order, each note under its quote.
export async function exportAnnotations(parentId: string, title: string, list: Annotation[]) {
  if (!list.length) throw new Error('还没有批注可以导出。');
  const sorted = [...list].sort(annotationOrder);
  const name = `${title}（批注）`;
  const content =
    `> 《${title}》的 ${sorted.length} 条高亮与批注，按原文顺序排列。\n\n` +
    sorted
      .map((item) => {
        const place = item.location.kind === 'pdf' ? `第 ${item.location.page} 页\n\n` : '';
        return `${place}${quoteBlock(item.quote)}${item.note ? `\n\n${item.note}` : ''}`;
      })
      .join('\n\n---\n\n') +
    '\n';
  const updated = await saveChildNote(parentId, name, content);
  return { title: name, count: sorted.length, updated };
}
