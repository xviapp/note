import type { FileInfo } from '../shared/types';
import { isSealedText, openText, sealedTextKeyId, sealText } from '../shared/encryption';
import { unlockedKey } from './keyring';
import { dropPhotos } from './pending-photos';

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
// Sealing is asynchronous; only the newest write may commit, and removal
// invalidates every in-flight write.
const generations = new Map<string, number>();
let epoch = 0;
export function writeDraft(id: string, draft: NoteDraft, keyId?: string | null) {
  const started = epoch;
  const generation = (generations.get(id) ?? 0) + 1;
  generations.set(id, generation);
  const store = (value: unknown) => {
    try {
      localStorage.setItem(DRAFT_PREFIX + id, JSON.stringify(value));
    } catch {
      /* Storage can be full or unavailable; the in-memory draft remains. */
    }
  };
  if (!keyId) return store(draft);
  return (async () => {
    const key = await unlockedKey(keyId);
    if (!key) return;
    const sealed = await sealText(key, keyId, JSON.stringify(draft));
    if (epoch === started && (generations.get(id) ?? 0) === generation) store({ sealed });
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
// Sign-out also invalidates drafts whose encryption is still in flight.
export function clearDrafts() {
  epoch++;
  generations.clear();
  void dropPhotos();
  // Loaded on demand: the outbox module imports the API client.
  void import('./journal-outbox').then(({ clearJournalOutbox }) => clearJournalOutbox()).catch(() => {});
  void import('./save-outbox').then(({ forgetSaves }) => forgetSaves()).catch(() => {});
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith(DRAFT_PREFIX)) localStorage.removeItem(key);
  } catch {
    /* Storage can be unavailable. */
  }
}
