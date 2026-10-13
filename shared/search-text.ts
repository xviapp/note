import type { NodeKind } from './types';

// What a reader sees of a note body, for full-text search on the server
// (worker/note-text.ts) and on the device for encrypted notes (src/local-search.ts):
// link and image text without their targets, no markup characters or HTML
// comments (discussion markers).
export function searchText(kind: NodeKind, content: string): string {
  if (kind !== 'markdown') return content;
  return content
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    .replace(/^[ \t]*(?:#{1,6}|>+|[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/(\*{1,3}|`+|~~)/g, '')
    .replace(/[ \t]+/g, ' ');
}

// The words around position `at` (UTF-16 index) of `text`.
export function excerptAt(text: string, at: number, length: number): string {
  const start = Math.max(0, at - 30),
    end = Math.min(text.length, at + length + 110);
  const line = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${line}${end < text.length ? '…' : ''}`;
}
