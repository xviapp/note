import type { FileInfo } from '../shared/types';

// Unsaved edits, kept on this device so a closed tab, a crash or Android
// reclaiming the app does not lose them. Cleared with the private cache on
// sign-out or session loss (see clearPrivateCache).
export const DRAFT_PREFIX = 'note-draft:';
export interface NoteDraft {
  content: string;
  attachments: FileInfo[];
  // The note revision the draft started from.
  revision: number;
  savedAt: number;
}
export function readDraft(id: string): NoteDraft | null {
  try {
    const value = JSON.parse(localStorage.getItem(DRAFT_PREFIX + id) || 'null');
    return value && typeof value.content === 'string' && Array.isArray(value.attachments)
      ? value
      : null;
  } catch {
    return null;
  }
}
export function writeDraft(id: string, draft: NoteDraft) {
  try {
    localStorage.setItem(DRAFT_PREFIX + id, JSON.stringify(draft));
  } catch {
    /* Storage can be full or unavailable; the in-memory draft remains. */
  }
}
export function removeDraft(id: string) {
  try {
    localStorage.removeItem(DRAFT_PREFIX + id);
  } catch {
    /* Storage can be unavailable. */
  }
}
