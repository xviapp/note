import type { SourceLocation } from './translation';

// Highlights and margin notes on a file, kept as one document per file.
export const ANNOTATION_COUNT = 1000;
export const ANNOTATION_QUOTE_CHARS = 4000;
export const ANNOTATION_NOTE_CHARS = 5000;
// What goes to Qingli when a question includes the file's notes.
export const ANNOTATION_CONTEXT_CHARS = 60_000;

export const ANNOTATION_COLORS = {
  yellow: '黄色',
  green: '绿色',
  blue: '蓝色',
  pink: '粉色',
  purple: '紫色',
} as const;
export type AnnotationColor = keyof typeof ANNOTATION_COLORS;
export function isAnnotationColor(value: unknown): value is AnnotationColor {
  return typeof value === 'string' && Object.hasOwn(ANNOTATION_COLORS, value);
}

export interface Annotation {
  id: string;
  // The selected text as shown, for the list and exports.
  quote: string;
  // Empty for a plain highlight.
  note: string;
  // Missing on annotations saved before colours existed: yellow.
  color?: AnnotationColor;
  location: SourceLocation;
  createdAt: number;
  updatedAt: number;
}
export const colorOf = (annotation: Pick<Annotation, 'color'>): AnnotationColor =>
  annotation.color ?? 'yellow';
export interface AnnotationList {
  annotations: Annotation[];
  updatedAt: number | null;
  // An encrypted list: the sealed document (base64url) and its object ID,
  // which a device decrypts into `annotations` and names when replacing it.
  sealed?: string;
  body?: string;
  // Set on the device when the list's key is not unlocked.
  locked?: string;
}

// Reading order: PDF pages first by page and height, then text by offset.
export const annotationOrder = (a: Annotation, b: Annotation) => {
  const key = ({ location }: Annotation): [number, number, number] =>
    location.kind === 'pdf'
      ? [0, location.page, Math.min(...location.rects.map((rect) => rect.y), 1)]
      : [1, location.start, 0];
  const [x, y] = [key(a), key(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || a.createdAt - b.createdAt;
};

// The file's annotations as plain text for Qingli, in reading order.
export function annotationsText(list: Annotation[], limit = ANNOTATION_CONTEXT_CHARS) {
  let text = '';
  const sorted = [...list].sort(annotationOrder);
  for (const [index, item] of sorted.entries()) {
    const place = item.location.kind === 'pdf' ? `（第 ${item.location.page} 页）` : '';
    const entry = `${index + 1}. ${place}原文：${item.quote.replace(/\s+/g, ' ')}${item.note ? `\n   我的批注：${item.note.replace(/\n/g, '\n   ')}` : ''}\n`;
    if (text.length + entry.length > limit) {
      text += `（篇幅所限，其余 ${sorted.length - index} 条批注已省略）\n`;
      break;
    }
    text += entry;
  }
  return text.trimEnd();
}

// One line per annotation in the search index: id, quote and note, each cut
// short. Only search reads it; the full text stays in R2.
export const SEARCH_FIELD = '\u001f';
export function annotationSearchText(list: Annotation[]) {
  return list
    .map((item) =>
      [item.id, item.quote.slice(0, 200), item.note.slice(0, 1000)]
        .map((part) => part.split(SEARCH_FIELD).join(' ').replace(/\n/g, ' '))
        .join(SEARCH_FIELD),
    )
    .join('\n')
    .slice(0, 500_000);
}
