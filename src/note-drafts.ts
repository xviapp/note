import type { FileInfo } from '../shared/types';
import { isSealedText, openText, sealedTextKeyId, sealText } from '../shared/encryption';
import { unlockedKey } from './keyring';
import { dropPhotos } from './pending-photos';

// Unsaved edits, kept on this device so a closed tab, a crash or Android
// reclaiming the app does not lose them. Cleared with the private cache on
// sign-out or session loss (see clearPrivateCache).
export const DRAFT_PREFIX = 'note-draft:';
// Section drafts must never replace a body queued by the full editor.
export const sectionDraftId = (id: string) => `section:${id}`;
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
// invalidates every in-flight write. The result says whether the draft is on
// this device: false when storage is full or unavailable, the key is locked or
// sign-out intervened (a newer write of the same draft counts as stored).
const generations = new Map<string, number>();
let epoch = 0;
// Shared by every window on this device (the notebook and Android's quick
// windows), so sign-out in one stops work started in another. Outside the
// draft prefix, so clearing the drafts keeps it.
const EPOCH_KEY = 'note:draft-epoch';
// Sign-out drops what devices keep; work started before it checks this before writing.
export function draftEpoch() {
  try {
    return `${epoch}:${localStorage.getItem(EPOCH_KEY) ?? ''}`;
  } catch {
    return String(epoch);
  }
}
export function writeDraft(id: string, draft: NoteDraft, keyId?: string | null): boolean | Promise<boolean> {
  const started = draftEpoch();
  const generation = (generations.get(id) ?? 0) + 1;
  generations.set(id, generation);
  const store = (value: unknown) => {
    try {
      localStorage.setItem(DRAFT_PREFIX + id, JSON.stringify(value));
      return true;
    } catch {
      /* Storage can be full or unavailable; the in-memory draft remains. */
      return false;
    }
  };
  if (!keyId) return store(draft);
  return (async () => {
    const key = await unlockedKey(keyId);
    if (!key) return false;
    const sealed = await sealText(key, keyId, JSON.stringify(draft));
    if (draftEpoch() !== started) return false;
    return (generations.get(id) ?? 0) !== generation || store({ sealed });
  })().catch(() => false);
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
  try {
    localStorage.setItem(EPOCH_KEY, crypto.randomUUID());
  } catch {
    /* Storage can be unavailable; this window still stops its own work. */
  }
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
