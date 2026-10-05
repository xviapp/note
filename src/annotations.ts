import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { Annotation, AnnotationList } from '../shared/annotations';
import type { TextSourceLocation } from '../shared/translation';
import { saveChildNote } from './child-note';
import { textSourceRange } from './source-location';

// One file's highlights and notes, loaded when the file opens. Changes are
// saved one annotation at a time and the server answers with the whole list.
export function useAnnotations(nodeId: string, enabled: boolean) {
  const [list, setList] = useState<Annotation[]>([]),
    [error, setError] = useState('');
  const current = useRef(nodeId);
  current.current = nodeId;
  useEffect(() => {
    setList([]);
    setError('');
    if (!enabled) return;
    let live = true;
    api<AnnotationList>(`/api/nodes/${nodeId}/annotations`)
      .then((result) => {
        if (live) setList(result.annotations);
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [nodeId, enabled]);
  const apply = useCallback((id: string, result: AnnotationList) => {
    if (current.current === id) setList(result.annotations);
  }, []);
  const save = useCallback(
    async (annotation: Pick<Annotation, 'id' | 'quote' | 'note' | 'location'>) => {
      const id = current.current;
      apply(
        id,
        await api<AnnotationList>(`/api/nodes/${id}/annotations/${annotation.id}`, 'PUT', {
          quote: annotation.quote,
          note: annotation.note,
          location: annotation.location,
        }),
      );
    },
    [apply],
  );
  const remove = useCallback(
    async (annotationId: string) => {
      const id = current.current;
      apply(
        id,
        await api<AnnotationList>(`/api/nodes/${id}/annotations/${annotationId}`, 'DELETE'),
      );
    },
    [apply],
  );
  return { list, error, save, remove };
}
export type AnnotationStore = ReturnType<typeof useAnnotations>;

// Reading order: PDF pages first by page and height, then text by offset.
export const annotationOrder = (a: Annotation, b: Annotation) => {
  const key = ({ location }: Annotation): [number, number, number] =>
    location.kind === 'pdf'
      ? [0, location.page, Math.min(...location.rects.map((rect) => rect.y), 1)]
      : [1, location.start, 0];
  const [x, y] = [key(a), key(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || a.createdAt - b.createdAt;
};

export const sameText = (a: TextSourceLocation, b: TextSourceLocation) =>
  a.start === b.start && a.end === b.end && a.exact === b.exact;

const HIGHLIGHT = 'annotation',
  NOTED = 'annotation-note';
export function clearAnnotationHighlights() {
  CSS.highlights?.delete(HIGHLIGHT);
  CSS.highlights?.delete(NOTED);
}

// Paints the annotations that can still be found in the text. Returns their
// ranges for hit testing; the rest are listed as no longer locatable.
export function paintAnnotations(root: HTMLElement, list: Annotation[]) {
  const ranges = new Map<string, Range>();
  const text = root.textContent || '';
  for (const annotation of list) {
    if (annotation.location.kind !== 'text') continue;
    const range = textSourceRange(root, annotation.location, text);
    if (typeof range !== 'string') ranges.set(annotation.id, range);
  }
  if (typeof Highlight !== 'undefined' && CSS.highlights) {
    const plain: Range[] = [],
      noted: Range[] = [];
    for (const annotation of list) {
      const range = ranges.get(annotation.id);
      if (range) (annotation.note ? noted : plain).push(range);
    }
    CSS.highlights.set(HIGHLIGHT, new Highlight(...plain));
    CSS.highlights.set(NOTED, new Highlight(...noted));
  }
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
