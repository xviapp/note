import { api, ApiError, lockNote, unlockNote } from './api';
import type { NoteDetail, NoteNode } from '../shared/types';
import { appendContent, recordTime } from '../shared/records';
export { appendContent } from '../shared/records';

// Keep the exact request after an uncertain response: a retry must not append
// the same block a second time. A version conflict starts from fresh text next time.
export function createNoteAppender(id: string, timestamp = false, operationKey?: string) {
  let pending: { key: string; payload: { content: string; attachments: string[]; revision: number } } | null = null;
  return async (title: string, text: string) => {
    if (!text.trim()) throw new Error('请先输入内容。');
    try {
      if (!pending) {
        const note = await api<NoteDetail>(`/api/nodes/${id}`);
        if (note.locked) throw new Error('请先解锁这篇笔记。');
        if (note.kind !== 'markdown' && note.kind !== 'text') throw new Error('只有文本笔记可以追加内容。');
        pending = {
          key: operationKey ?? crypto.randomUUID(),
          payload: {
            content: appendContent(note.content, title, text, note.kind === 'markdown', timestamp ? recordTime() : undefined),
            attachments: note.attachments.map((file) => file.id),
            revision: note.revision,
          },
        };
      }
      await unlockNote(id);
      await api<NoteNode>(`/api/nodes/${id}/content`, 'PUT', pending.payload, pending.key);
      pending = null;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        pending = null;
        throw new Error('正文已在其他页面更新，输入已保留。再次追加会接在最新正文后。', { cause: error });
      }
      throw error;
    } finally {
      lockNote(id);
    }
  };
}
