import { fileUrl, uncertainFailure, upload } from './api';
import { isOffline } from './connectivity';
import { createJournalRecorder } from './journal-record';
import { isUnlocked } from './keyring';
import { draftEpoch } from './note-drafts';

// 今日记 for an encrypted journal that is not unlocked on this device. The
// record cannot be sealed with the journal's key yet, so it waits here, sealed
// with a key that never leaves this device (a non-extractable WebCrypto key,
// like the Android 随手记 window's Keystore inbox). Once the journal is unlocked the
// record and its photos are sealed with the journal key, uploaded, and added
// to the day they were written. Cleared on sign-out with the drafts.
export interface OutboxRecord {
  journalId: string;
  keyId: string;
  date: string;
  title: string;
  text: string;
  // One operation per record, so a resend never adds it twice.
  operationKey: string;
  photos: File[];
}
interface Stored {
  id: string;
  // 'draft': still being written in the window; 'queued': saved, waiting for the key.
  status: 'draft' | 'queued';
  journalId: string;
  keyId: string;
  date: string;
  createdAt: number;
  iv: ArrayBuffer;
  sealed: ArrayBuffer;
  photos: { iv: ArrayBuffer; sealed: ArrayBuffer }[];
  error?: string;
}
interface Payload {
  title: string;
  text: string;
  operationKey: string;
  photos: { name: string; type: string; lastModified: number }[];
}

let database: Promise<IDBDatabase> | undefined;
function open() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('yejian-journal-outbox', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('device');
      request.result.createObjectStore('records', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
  }));
}
async function store<T>(name: 'device' | 'records', mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T> | void) {
  const db = await open();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const request = action(tx.objectStore(name));
    tx.oncomplete = () => resolve(request?.result);
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}

let deviceKey: Promise<CryptoKey> | undefined;
function key() {
  return (deviceKey ??= (async () => {
    const saved = await store<CryptoKey>('device', 'readonly', (keys) => keys.get('key'));
    if (saved) return saved;
    const created = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await store('device', 'readwrite', (keys) => keys.put(created, 'key'));
    return created;
  })().catch((error) => {
    deviceKey = undefined;
    throw error;
  }));
}
async function seal(bytes: ArrayBuffer) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv: iv.buffer, sealed: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), bytes) };
}
const unseal = async (part: { iv: ArrayBuffer; sealed: ArrayBuffer }) =>
  crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(part.iv) }, await key(), part.sealed);

const draftId = (journalId: string, date: string) => `draft:${journalId}:${date}`;
const listeners = new Set<() => void>();
export function subscribeOutbox(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
const changed = () => listeners.forEach((listener) => listener());

// Sign-out clears the records: work started before it writes nothing.
async function write(id: string, status: Stored['status'], record: OutboxRecord, createdAt = Date.now()) {
  const started = draftEpoch();
  const payload: Payload = {
    title: record.title,
    text: record.text,
    operationKey: record.operationKey,
    photos: record.photos.map(({ name, type, lastModified }) => ({ name, type, lastModified })),
  };
  const head = await seal(new TextEncoder().encode(JSON.stringify(payload)).buffer as ArrayBuffer);
  const photos = [];
  for (const photo of record.photos) photos.push(await seal(await photo.arrayBuffer()));
  const value: Stored = {
    id, status, journalId: record.journalId, keyId: record.keyId, date: record.date, createdAt, ...head, photos,
  };
  await store('records', 'readwrite', (records) => {
    if (draftEpoch() === started) records.put(value);
  });
}
async function read(row: Stored): Promise<OutboxRecord> {
  const payload = JSON.parse(new TextDecoder().decode(await unseal(row))) as Payload;
  const photos: File[] = [];
  for (const [index, photo] of payload.photos.entries())
    photos.push(new File([await unseal(row.photos[index]!)], photo.name, { type: photo.type, lastModified: photo.lastModified }));
  return { journalId: row.journalId, keyId: row.keyId, date: row.date, title: payload.title, text: payload.text, operationKey: payload.operationKey, photos };
}

// The window's unsaved input for a day, kept like any draft.
export async function loadOutboxDraft(journalId: string, date: string) {
  const row = await store<Stored>('records', 'readonly', (records) => records.get(draftId(journalId, date)));
  return row ? read(row).catch(() => null) : null;
}
export async function saveOutboxDraft(record: OutboxRecord) {
  const id = draftId(record.journalId, record.date);
  if (!record.title && !record.text.trim() && !record.photos.length)
    await store('records', 'readwrite', (records) => records.delete(id));
  else await write(id, 'draft', record);
}
// Saved: the record waits for the journal's key, and the draft is cleared.
export async function queueOutboxRecord(record: OutboxRecord) {
  await write(crypto.randomUUID(), 'queued', record);
  await store('records', 'readwrite', (records) => records.delete(draftId(record.journalId, record.date)));
  changed();
}
export async function queuedOutbox(journalId?: string) {
  const rows = ((await store<Stored[]>('records', 'readonly', (records) => records.getAll()).catch(() => [])) ?? [])
    .filter((row) => row.status === 'queued' && (!journalId || row.journalId === journalId));
  return rows.map(({ id, journalId: journal, date, error }) => ({ id, journalId: journal, date, error }));
}

// What waits, opened on this device for the 待发送 list (newest first).
export async function listOutbox() {
  const rows = ((await store<Stored[]>('records', 'readonly', (records) => records.getAll()).catch(() => [])) ?? [])
    .filter((row) => row.status === 'queued')
    .sort((a, b) => b.createdAt - a.createdAt);
  const result = [];
  for (const row of rows) {
    const payload = await unseal(row)
      .then((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as Payload)
      .catch(() => null);
    result.push({
      id: row.id, journalId: row.journalId, keyId: row.keyId, date: row.date, createdAt: row.createdAt,
      title: payload?.title ?? '', text: payload?.text ?? '', photos: row.photos.length, error: row.error,
    });
  }
  return result;
}
export async function removeOutboxRecord(id: string) {
  await store('records', 'readwrite', (records) => records.delete(id));
  changed();
}

let flushing: Promise<number> | null = null;
// Sends every waiting record whose journal is unlocked here, oldest first.
// Returns how many were added; a failed one stays with its reason.
export function flushJournalOutbox(): Promise<number> {
  if (flushing) return flushing;
  if (isOffline()) return Promise.resolve(0);
  // Cleared once settled, never before it is stored.
  flushing = (async () => {
    let sent = 0;
    const started = draftEpoch();
    try {
      const rows = ((await store<Stored[]>('records', 'readonly', (records) => records.getAll())) ?? [])
        .filter((row) => row.status === 'queued' && isUnlocked(row.keyId))
        .sort((a, b) => a.createdAt - b.createdAt);
      for (const row of rows) {
        if (draftEpoch() !== started) break;
        try {
          const record = await read(row);
          const images = [];
          for (const photo of record.photos) images.push(await upload(photo, record.journalId));
          const body = [
            record.text.trim(),
            ...images.map((file) => `![${file.name.replace(/[[\]\\]/g, '')}](${fileUrl(file.id)})`),
          ].filter(Boolean).join('\n\n');
          const ids = images.map((file) => file.id);
          await createJournalRecorder(record.journalId, record.date)(
            record.title, body, record.operationKey, ids.length ? ids : undefined);
          await store('records', 'readwrite', (records) => records.delete(row.id));
          sent++;
        } catch (reason) {
          // A connection lost midway retries later as it is; a refusal is kept with its reason.
          if (uncertainFailure(reason) || draftEpoch() !== started) break;
          await store('records', 'readwrite', (records) => {
            if (draftEpoch() === started) records.put({ ...row, error: (reason as Error).message });
          });
          changed();
        }
      }
    } finally {
      if (sent) changed();
    }
    return sent;
  })()
    .catch(() => 0)
    .finally(() => {
      flushing = null;
    });
  return flushing;
}

export async function clearJournalOutbox() {
  await store('records', 'readwrite', (records) => records.clear()).catch(() => {});
  changed();
}
