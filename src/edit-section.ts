import { api, ApiError, lockNote, uncertainFailure, unlockNote } from './api';
import type { NoteDetail, NoteNode } from '../shared/types';
import { replaceSection, type MarkdownSection } from './markdown-sections';

// A section edit always checks the revision it was opened from. Uncertain
// writes keep the exact payload and key until the user explicitly retries.
export function createSectionWriter(note: NoteDetail, section?: MarkdownSection) {
  let pending: { key: string; payload: { content: string; revision: number; attachments: string[] } } | null = null;
  return async (replacement: string, extraAttachments?: string[]): Promise<NoteDetail> => {
    const attachments = Array.from(
      new Set([...note.attachments.map((file) => file.id), ...(extraAttachments ?? [])]),
    );
    pending ??= {
      key: crypto.randomUUID(),
      payload: {
        content: section ? replaceSection(note.content, section, replacement) : replacement,
        revision: note.revision,
        attachments,
      },
    };
    try {
      await unlockNote(note.id);
      const saved = await api<NoteNode>(`/api/nodes/${note.id}/content`, 'PUT', pending.payload, pending.key);
      // An idempotent retry can return metadata from a newer edit. Read its
      // actual body instead of pairing that revision with our older payload.
      const detail = await api<NoteDetail>(`/api/nodes/${note.id}`);
      if (detail.revision < saved.revision)
        throw new ApiError('正文已提交，但暂时无法确认最新版本。草稿已保留，请联网后重试。', 0);
      pending = null;
      return detail;
    } catch (error) {
      if (!uncertainFailure(error)) pending = null;
      throw error;
    } finally {
      lockNote(note.id);
    }
  };
}
