import { recordSent, sentExcerpt } from './sent-history';
import { draftEpoch } from './note-drafts';
import { api } from './api';
import { createNoteAppender } from './append-note';
import { appendRecord } from '../shared/records';
import { defaultEntry } from '../shared/journals';
import type { NoteNode } from '../shared/types';

// The first record and date heading are saved together. If another device wrote
// this day meanwhile, append to that entry without replacing its contents.
export function createJournalRecorder(journalId: string, date: string) {
  let existing: { id: string; key: string; append: ReturnType<typeof createNoteAppender> } | null = null;
  return async (title: string, text: string, key: string, attachmentIds: string[] = []) => {
    const started = draftEpoch();
    if (!text.trim() && attachmentIds.length === 0) throw new Error('请先输入内容。');
    const body: { date: string; content: string; attachments?: string[] } = {
      date,
      content: appendRecord(defaultEntry(date), 'journal', title, text),
    };
    if (attachmentIds.length > 0) body.attachments = attachmentIds;
    const result = await api<{ node: NoteNode; created: boolean }>(
      `/api/nodes/${journalId}/journal/entries`, 'POST',
      body, key,
    );
    if (!result.created) {
      if (existing?.id !== result.node.id || existing.key !== key)
        existing = { id: result.node.id, key, append: createNoteAppender(result.node.id, 'journal', `${key}-append`) };
      await existing.append(title, text, undefined, attachmentIds);
    }
    recordSent({ id: `journal:${key}`, summary: result.node.key_id ? '（加密内容）' : sentExcerpt(title || text) || '（只有照片）', detail: `今日记 · ${date}` }, started);
    return result;
  };
}
