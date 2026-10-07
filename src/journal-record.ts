import { api } from './api';
import { appendContent, createNoteAppender } from './append-note';
import type { NoteNode } from '../shared/types';

// The first record and template are saved together. If another device wrote
// this day meanwhile, append to that entry without replacing its contents.
export function createJournalRecorder(journalId: string, date: string, template: string) {
  let existing: { id: string; key: string; append: ReturnType<typeof createNoteAppender> } | null = null;
  return async (title: string, text: string, key: string) => {
    if (!text.trim()) throw new Error('请先输入内容。');
    const result = await api<{ node: NoteNode; created: boolean }>(
      `/api/nodes/${journalId}/journal/entries`, 'POST',
      { date, content: appendContent(template, title, text) }, key,
    );
    if (!result.created) {
      if (existing?.id !== result.node.id || existing.key !== key)
        existing = { id: result.node.id, key, append: createNoteAppender(result.node.id, false, `${key}-append`) };
      await existing.append(title, text);
    }
    return result;
  };
}
