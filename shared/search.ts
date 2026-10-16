import { variantOf, type NoteNode } from './types';

export const searchTypes = {
  all: '全部类型', note: '笔记', folder: '文件夹', paper: '论文', book: '书籍',
  pdf: 'PDF', image: '图片', link: '网页链接', journal: '日记本', project: '项目',
} as const;
export type SearchType = keyof typeof searchTypes;
export type SearchSort = 'relevance' | 'updated';
export interface SearchOptions { type?: SearchType; sort?: SearchSort; parent?: string }
export function matchesSearchType(node: NoteNode, type: SearchType = 'all') {
  const variant = variantOf(node);
  return variant !== 'discussion' && (type === 'all' || (type === 'note' ? ['markdown', 'text', 'book-page'].includes(variant) : variant === type));
}
export function searchRank(node: NoteNode & { excerpt?: string; annotation?: unknown }, words: string[]) {
  if (node.annotation) return 3;
  const title = node.title.toLowerCase(), lower = words.map((word) => word.toLowerCase());
  if (title === lower.join(' ')) return 0;
  if (lower.every((word) => title.includes(word))) return 1;
  return node.excerpt ? 2 : 3;
}
export function compareSearch(a: NoteNode, b: NoteNode, words: string[], sort: SearchSort = 'relevance') {
  return (sort === 'relevance' ? searchRank(a, words) - searchRank(b, words) : 0)
    || b.updated_at - a.updated_at || a.id.localeCompare(b.id);
}
