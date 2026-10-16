import { useSyncExternalStore } from 'react';
import { variantOf, type NoteNode } from '../shared/types';
import { typeLabel } from './note-types/registry';

export type ListSort = 'default' | 'updated' | 'title';
type Preferences = { sort: ListSort; compact: boolean };
const key = 'note:list-preferences';
function read(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}');
    return { sort: ['updated', 'title'].includes(value.sort) ? value.sort : 'default', compact: value.compact === true };
  } catch { return { sort: 'default', compact: false }; }
}
let current = read();
const listeners = new Set<() => void>();
export function setListPreferences(value: Partial<Preferences>) {
  current = { ...current, ...value };
  try { localStorage.setItem(key, JSON.stringify(current)); } catch { /* Optional device preference. */ }
  listeners.forEach((listener) => listener());
}
window.addEventListener('storage', (event) => {
  if (event.key !== key && event.key !== null) return;
  current = read();
  listeners.forEach((listener) => listener());
});
export function useListPreferences() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, () => current);
}
export function nodeDescription(node: NoteNode) {
  if (variantOf(node) === 'book') {
    if (node.book_page_number) return `读到第 ${node.book_page_number} 页${node.book_total_pages ? ` / 共 ${node.book_total_pages} 页` : ''}`;
    if (node.book_total_pages) return `共 ${node.book_total_pages} 页`;
  }
  if (node.kind === 'folder') return `${typeLabel(node)} · ${node.child_count ?? 0} 个下级条目`;
  if (!node.key_id && node.preview?.trim()) {
    const lines = node.preview.trim().split(/\r?\n/);
    if (lines[0].trim() === node.title.trim()) lines.shift();
    const summary = lines.join(' ').replace(/\s+/g, ' ').trim();
    if (summary) return summary;
  }
  const ratio = node.reading_position?.ratio;
  if (node.kind === 'pdf' && node.reading_position?.page) return `读到第 ${node.reading_position.page} 页`;
  if (ratio && ratio > 0.02) return ratio >= 0.98 ? '已读到末尾' : `读到 ${Math.round(ratio * 100)}%`;
  return node.arxiv_id ? `arXiv · ${node.arxiv_id}` : node.kind === 'link' ? node.url ?? typeLabel(node) : typeLabel(node);
}
