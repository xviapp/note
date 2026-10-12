import { fileUrl, uncertainFailure, upload } from './api';
import { isOffline } from './connectivity';
import { createJournalRecorder } from './journal-record';
import { isUnlocked } from './keyring';
import { DRAFT_PREFIX, readDraft, removeDraft } from './note-drafts';
import { dropPhotos, pendingPhotos } from './pending-photos';
import { localDate } from '../shared/journals';
import type { FileInfo } from '../shared/types';

// 今日记 saved in the window (QuickAppend's draft `append:journal:<journal>:<date>`)
// that the server may not have: Android ended the app, or the save failed. The
// window resumes only today's, so these go out on the day they were written,
// from the notebook and the window (earlier days; today's composer handles its
// own) and from 设置 → 待发送 (all). The record's operation key keeps a resend
// from adding it twice. A record sealed with a locked key is listed from its
// mark (below) as waiting to be unlocked.
export interface QuickRecord {
  draftId: string;
  journalId: string;
  date: string;
  title: string;
  text: string;
  images: FileInfo[];
  operationKey: string;
  savedAt: number;
  // Photos chosen but not uploaded yet.
  photos: number;
  error?: string;
  // The key it is sealed with, while locked here; nothing else is readable then.
  locked?: string;
}
const DAY_DRAFT = /^append:journal:([^:]+):(\d{4}-\d{2}-\d{2})$/;

// Which day drafts were saved, readable without their key: the draft, its key
// and when, never the record. Under the draft prefix, so sign-out clears it;
// listing drops the marks of drafts that are gone or no longer saved.
interface Mark {
  draftId: string;
  keyId: string;
  savedAt: number;
}
const MARKS = `${DRAFT_PREFIX}quick-records`;
function readMarks(): Mark[] {
  try {
    const value = JSON.parse(localStorage.getItem(MARKS) || '[]');
    return Array.isArray(value) ? value.filter((mark) => typeof mark?.draftId === 'string') : [];
  } catch {
    return [];
  }
}
function writeMarks(marks: Mark[]) {
  try {
    if (marks.length) localStorage.setItem(MARKS, JSON.stringify(marks));
    else localStorage.removeItem(MARKS);
  } catch {
    /* Storage can be unavailable; a locked record is then only on the calendar. */
  }
}
// QuickAppend marks a saved record of an encrypted journal, and unmarks it
// when it is input again (a refused save).
export function markQuickRecord(draftId: string, keyId: string | null | undefined, saved = true) {
  if (!DAY_DRAFT.test(draftId)) return;
  if (!keyId || !saved) return unmark(draftId);
  const marks = readMarks();
  if (marks.some((mark) => mark.draftId === draftId)) return;
  writeMarks([...marks, { draftId, keyId, savedAt: Date.now() }]);
}
const unmark = (draftId: string) => {
  const marks = readMarks();
  if (marks.some((mark) => mark.draftId === draftId)) writeMarks(marks.filter((mark) => mark.draftId !== draftId));
};

// The text and photos of a quick record, as QuickAppend appends them.
export function quickRecordBody(text: string, images: FileInfo[]) {
  const imageText = images
    .map((file) => `![${file.name.replace(/[[\]\\]/g, '')}](${fileUrl(file.id)})`)
    .join('\n\n');
  return [text.trim(), imageText].filter(Boolean).join('\n\n');
}

// Drafts open in a composer in this window: it sends them itself, so a flush
// leaves them alone instead of uploading the same photos alongside it.
const held = new Map<string, number>();
export function holdQuickRecord(draftId: string) {
  held.set(draftId, (held.get(draftId) ?? 0) + 1);
  return () => {
    const count = (held.get(draftId) ?? 1) - 1;
    if (count > 0) held.set(draftId, count);
    else held.delete(draftId);
  };
}

// Refusals are kept for this session, beside the record.
const errors = new Map<string, string>();
const listeners = new Set<() => void>();
export function subscribeQuickRecords(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
const changed = () => listeners.forEach((listener) => listener());

// Saved records still on this device, oldest first.
export async function queuedQuickRecords(): Promise<QuickRecord[]> {
  let ids: string[] = [];
  try {
    ids = Object.keys(localStorage)
      .filter((key) => key.startsWith(DRAFT_PREFIX))
      .map((key) => key.slice(DRAFT_PREFIX.length))
      .filter((id) => DAY_DRAFT.test(id));
  } catch {
    return [];
  }
  const marks = new Map(readMarks().map((mark) => [mark.draftId, mark]));
  const records: QuickRecord[] = [];
  for (const draftId of ids) {
    const [, journalId, date] = DAY_DRAFT.exec(draftId)!;
    const mark = marks.get(draftId);
    marks.delete(draftId);
    const draft = await readDraft(draftId);
    if (!draft) {
      if (mark && !isUnlocked(mark.keyId))
        records.push({
          draftId, journalId: journalId!, date: date!, title: '', text: '', images: [], operationKey: '',
          savedAt: mark.savedAt, photos: 0, locked: mark.keyId,
        });
      continue;
    }
    let saved: Record<string, unknown> = {};
    try {
      saved = JSON.parse(draft.content);
    } catch {
      /* An invalid draft is not a record. */
    }
    // Only what 保存 was pressed for; unsaved input stays a draft.
    if (
      (saved.queued !== true && saved.retrying !== true) ||
      typeof saved.operationKey !== 'string' || typeof saved.text !== 'string'
    ) {
      if (mark) unmark(draftId);
      continue;
    }
    records.push({
      draftId, journalId: journalId!, date: date!,
      title: typeof saved.title === 'string' ? saved.title : '',
      text: saved.text,
      images: Array.isArray(saved.attachments) ? (saved.attachments as FileInfo[]) : draft.attachments,
      operationKey: saved.operationKey,
      savedAt: draft.savedAt,
      photos: (await pendingPhotos(draftId)).length,
      error: errors.get(draftId),
    });
  }
  // Marks whose draft is gone.
  for (const draftId of marks.keys()) unmark(draftId);
  return records.sort((a, b) => a.savedAt - b.savedAt);
}

async function send(record: QuickRecord) {
  const images = [...record.images];
  for (const photo of await pendingPhotos(record.draftId)) images.push(await upload(photo.file, record.journalId));
  const ids = images.map((file) => file.id);
  await createJournalRecorder(record.journalId, record.date)(
    record.title, quickRecordBody(record.text, images), record.operationKey, ids.length ? ids : undefined);
  removeDraft(record.draftId);
  unmark(record.draftId);
  await dropPhotos(record.draftId);
}

let flushing: Promise<number> | null = null;
// Sends the saved records (`earlier`: only those before today), oldest first.
// Returns how many were added; a refused one stays with its reason.
export function flushQuickRecords({ earlier = false } = {}): Promise<number> {
  // A round of earlier days only does not stand in for a full one.
  if (flushing) return earlier ? flushing : flushing.then(() => flushQuickRecords());
  if (isOffline()) return Promise.resolve(0);
  // Cleared once settled, never before it is stored.
  flushing = (async () => {
    let sent = 0;
    try {
      const today = localDate();
      for (const record of await queuedQuickRecords()) {
        if (record.locked || held.has(record.draftId) || (earlier && record.date >= today)) continue;
        try {
          await send(record);
          errors.delete(record.draftId);
          sent++;
        } catch (reason) {
          if (uncertainFailure(reason)) break;
          errors.set(record.draftId, (reason as Error).message);
        }
      }
    } finally {
      changed();
    }
    return sent;
  })()
    .catch(() => 0)
    .finally(() => {
      flushing = null;
    });
  return flushing;
}

export async function discardQuickRecord(draftId: string) {
  removeDraft(draftId);
  unmark(draftId);
  await dropPhotos(draftId);
  errors.delete(draftId);
  changed();
}
