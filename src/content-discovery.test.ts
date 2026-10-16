import { expect, it } from 'vitest';
import type { NoteNode } from '../shared/types';
import { nodeDescription } from './list-preferences';
import { matchesSearchType, compareSearch } from '../shared/search';
import { rewriteBackupText } from '../shared/backup';

const note = (fields: Partial<NoteNode>) => ({ id: 'note', kind: 'markdown', title: '笔记', updated_at: 1, ...fields }) as NoteNode;
it('describes content and book progress without displaying an encrypted preview', () => {
  expect(nodeDescription(note({ preview: '一句\n摘要' }))).toBe('一句 摘要');
  expect(nodeDescription(note({ title: '重复', preview: '重复' }))).not.toBe('重复');
  expect(nodeDescription(note({ preview: '秘密', key_id: 'locked' }))).not.toContain('秘密');
  expect(nodeDescription(note({ kind: 'folder', child_count: 4 }))).toContain('4 个下级条目');
  expect(nodeDescription(note({ kind: 'folder', variant: 'book', book_page_number: 12, book_total_pages: 80 }))).toBe('读到第 12 页 / 共 80 页');
});
it('keeps papers out of plain links and ranks exact titles ahead of recency', () => {
  expect(matchesSearchType(note({ variant: 'discussion' }))).toBe(false);
  expect(matchesSearchType(note({ kind: 'link', arxiv_id: '2503.01800' }), 'link')).toBe(false);
  expect(matchesSearchType(note({ kind: 'link', arxiv_id: '2503.01800' }), 'paper')).toBe(true);
  const exact = note({ title: '知识', updated_at: 1 }), partial = note({ title: '知识笔记', updated_at: 100 });
  expect(compareSearch(exact, partial, ['知识'])).toBeLessThan(0);
  expect(compareSearch(exact, partial, ['知识'], 'updated')).toBeGreaterThan(0);
});
it('restores chat source links to the restored nodes while retaining source snapshots', () => {
  const text = JSON.stringify({ quoteSource: { nodeId: 'old', title: '原来的标题' }, files: [{ origin: { nodeId: 'old', title: '原文', section: '第一章' } }] });
  const restored = JSON.parse(rewriteBackupText(text, { old: 'restored' }));
  expect(restored.quoteSource).toEqual({ nodeId: 'restored', title: '原来的标题' });
  expect(restored.files[0].origin).toEqual({ nodeId: 'restored', title: '原文', section: '第一章' });
});
