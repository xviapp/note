import { recordSent } from './sent-history';
import { api, lockNote, uncertainFailure, unlockNote } from './api';
import { isOffline } from './connectivity';
import { isUnlocked } from './keyring';
import { DRAFT_PREFIX, draftEpoch, readDraft, removeDraft, writeDraft } from './note-drafts';
import type { FileInfo, NoteDetail, NoteNode } from '../shared/types';

// 保存 returns to the note at once; the body is sent from here. The draft
// (note-drafts.ts) holds what is saved, so a closed app loses nothing, and one
// operation key per save keeps a resend from applying twice. A connection
// problem waits and retries; a refusal (another device saved first) goes back
// to the open note's editor, or waits in 设置 → 待发送 with its draft. Kept
// under the draft prefix, so signing out clears it with the drafts.
export interface PendingSave {
  id: string;
  title: string;
  keyId: string | null;
  // The revision the edit started from; the server refuses a stale one.
  revision: number;
  key: string;
  savedAt: number;
  // The savedAt of the draft written for this save. Entries queued by 0.4.24
  // lack it (their draft was stamped separately, a little earlier).
  draftAt?: number;
  error?: string;
}
const STORE = `${DRAFT_PREFIX}saves`;
function read(): PendingSave[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORE) || '[]');
    return Array.isArray(value) ? value.filter((item) => typeof item?.id === 'string') : [];
  } catch {
    return [];
  }
}
let saves = read();
const listeners = new Set<() => void>();
function write(next: PendingSave[]) {
  saves = next;
  try {
    if (next.length) localStorage.setItem(STORE, JSON.stringify(next));
    else localStorage.removeItem(STORE);
  } catch {
    /* Storage can be unavailable; the saves stay in memory. */
  }
  listeners.forEach((listener) => listener());
}
window.addEventListener('storage', (event) => {
  if (event.key !== STORE && event.key !== null) return;
  saves = read();
  listeners.forEach((listener) => listener());
});
export const pendingSaves = () => saves;
export const pendingSave = (id: string) => saves.find((item) => item.id === id);
export function subscribeSaves(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

// Throws when the body cannot be kept on this device: the editor keeps it then.
export async function queueSave(note: NoteDetail, content: string, attachments: FileInfo[]) {
  const savedAt = Date.now();
  if (!(await writeDraft(note.id, { content, attachments, revision: note.revision, savedAt }, note.key_id ?? null)))
    throw new Error('无法在本机暂存正文，编辑内容已保留。请清理本机存储空间或稍后重试。');
  write([
    ...saves.filter((item) => item.id !== note.id),
    { id: note.id, title: note.title, keyId: note.key_id ?? null, revision: note.revision, key: crypto.randomUUID(), savedAt, draftAt: savedAt },
  ]);
  void flushSaves();
}
export async function discardSave(id: string) {
  write(saves.filter((item) => item.id !== id));
  removeDraft(id);
}

// The note page owns a refused save it can reopen; `handled` says it did.
export interface SaveFailure {
  id: string;
  message: string;
  // VERSION_CONFLICT: another device or page saved first.
  code?: string;
  handled: boolean;
}

let flushing: Promise<void> | null = null;
let again = false;
export function flushSaves(retryRefused = false): Promise<void> {
  if (flushing) {
    again = true;
    return flushing;
  }
  flushing = (async () => {
    do {
      again = false;
      for (const item of [...saves]) {
        if ((item.error && !retryRefused) || isOffline()) continue;
        if (item.keyId && !isUnlocked(item.keyId)) continue;
        if (!(await send(item))) break;
      }
      retryRefused = false;
    } while (again);
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}
// False stops the round: the connection is lost and later saves wait too.
async function send(item: PendingSave): Promise<boolean> {
  const started = draftEpoch();
  const draft = await readDraft(item.id);
  // The body saved with this entry, or a later edit of it; never an older draft.
  if (!draft || draft.savedAt < (item.draftAt ?? 0)) {
    const message = '本机找不到这次保存的正文，未发送。';
    write(saves.map((entry) => (entry.key === item.key ? { ...entry, error: message } : entry)));
    return true;
  }
  try {
    await unlockNote(item.id);
    const saved = await api<NoteNode>(`/api/nodes/${item.id}/content`, 'PUT', {
      content: draft.content,
      attachments: draft.attachments.map((file) => file.id),
      revision: item.revision,
    }, item.key);
    recordSent({ id: `saves:${item.key}`, summary: item.keyId ? '（加密内容）' : item.title || '无标题笔记', detail: '笔记修改' }, started);
    const detail = await api<NoteDetail>(`/api/nodes/${item.id}`);
    // The save may be newer than this entry: another one replaced it meanwhile.
    if (pendingSave(item.id)?.key !== item.key) return true;
    if (detail.revision < saved.revision) throw new Error('还没确认保存成功。');
    const latest = await readDraft(item.id);
    if (latest?.savedAt === draft.savedAt) removeDraft(item.id);
    write(saves.filter((entry) => entry.key !== item.key));
    window.dispatchEvent(new CustomEvent<NoteDetail>('note:saved', { detail }));
    return true;
  } catch (reason) {
    if (uncertainFailure(reason)) return false;
    const message = (reason as Error).message || '保存未完成。';
    const failure: SaveFailure = {
      id: item.id, message, code: (reason as { code?: string }).code, handled: false,
    };
    window.dispatchEvent(new CustomEvent<SaveFailure>('note:save-failed', { detail: failure }));
    // An open note took it back into its editor (with the draft); otherwise it waits.
    write(
      failure.handled
        ? saves.filter((entry) => entry.key !== item.key)
        : saves.map((entry) => (entry.key === item.key ? { ...entry, error: message } : entry)),
    );
    return true;
  } finally {
    lockNote(item.id);
  }
}

// Signing out (clearDrafts) drops what waits here with the drafts.
export function forgetSaves() {
  write([]);
}

// Settles once the note has no save on its way (sent, or refused and waiting).
export function waitForSave(id: string): Promise<void> {
  return new Promise((resolve) => {
    const settled = () => {
      const item = pendingSave(id);
      return !item || !!item.error;
    };
    if (settled()) return resolve();
    const stop = subscribeSaves(() => {
      if (!settled()) return;
      stop();
      resolve();
    });
  });
}
