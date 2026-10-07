import type { FileInfo } from '../shared/types';
import { isSealedText, openText, sealedTextKeyId, sealText } from '../shared/encryption';
import { unlockedKey } from './keyring';

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
// An encrypted note's draft is sealed with its key; it can be offered again
// only while the key is unlocked.
export async function readDraft(id: string): Promise<NoteDraft | null> {
  try {
    let value = JSON.parse(localStorage.getItem(DRAFT_PREFIX + id) || 'null');
    if (isSealedText(value?.sealed)) {
      const key = await unlockedKey(sealedTextKeyId(value.sealed) ?? '');
      value = key ? JSON.parse(await openText(key, value.sealed)) : null;
    }
    return value && typeof value.content === 'string' && Array.isArray(value.attachments)
      ? value
      : null;
  } catch {
    return null;
  }
}
// Sealing is asynchronous; a draft removed meanwhile is not written back.
const generations = new Map<string, number>();
export function writeDraft(id: string, draft: NoteDraft, keyId?: string | null) {
  const store = (value: unknown) => {
    try {
      localStorage.setItem(DRAFT_PREFIX + id, JSON.stringify(value));
    } catch {
      /* Storage can be full or unavailable; the in-memory draft remains. */
    }
  };
  if (!keyId) return store(draft);
  const generation = generations.get(id) ?? 0;
  void (async () => {
    const key = await unlockedKey(keyId);
    if (!key) return;
    const sealed = await sealText(key, keyId, JSON.stringify(draft));
    if ((generations.get(id) ?? 0) === generation) store({ sealed });
  })().catch(() => {});
}
export function hasDraft(id: string) {
  try {
    return localStorage.getItem(DRAFT_PREFIX + id) !== null;
  } catch {
    return false;
  }
}
export function removeDraft(id: string) {
  generations.set(id, (generations.get(id) ?? 0) + 1);
  try {
    localStorage.removeItem(DRAFT_PREFIX + id);
  } catch {
    /* Storage can be unavailable. */
  }
}
