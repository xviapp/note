import { useSyncExternalStore } from 'react';
import { api, ApiError, cachedApi, parse, uncertainFailure, upload, uploadSealed } from './api';
import {
  CLIP_CHARS,
  CLIP_IMAGE_BYTES,
  CLIP_IMAGE_MIME,
  type Clip,
  type ClipList,
} from '../shared/clips';
import { isSealedText, openText, sealedTextKeyId } from '../shared/encryption';
import { keyOrThrow, plainUpload, reveal, sealData, sealString } from './encryption';
import { DRAFT_PREFIX } from './note-drafts';
import { isOffline } from './connectivity';
import { proxyReady } from './proxy';

// Quick clips (随手记). A new clip goes to an outbox on this device first and
// shows at once; the outbox is sent in order whenever the server is reachable.
// Clips are independent and carry their own ID, so a resend never duplicates
// one. The outbox sits under the draft prefix, so signing out clears it too.
// An image is uploaded when the clip is added, so a clip with one needs a
// connection; only its small record waits in the outbox.
export interface PendingClip {
  id: string;
  // As it will be sent: sealed with the clip key, or plain.
  text: string;
  sourceId: string | null;
  sourceTitle?: string | null;
  createdAt: number;
  file?: Clip['file'];
  // Why the server refused it; it stays until removed or sent.
  error?: string;
}
const OUTBOX = `${DRAFT_PREFIX}clips`;
const listeners = new Set<() => void>();
let outbox = readOutbox();
let keyId: string | null | undefined;

function readOutbox(): PendingClip[] {
  try {
    const value = JSON.parse(localStorage.getItem(OUTBOX) || '[]');
    return Array.isArray(value)
      ? value.filter((item) => typeof item?.id === 'string' && typeof item.text === 'string')
      : [];
  } catch {
    return [];
  }
}
function writeOutbox(next: PendingClip[]) {
  outbox = next;
  try {
    if (next.length) localStorage.setItem(OUTBOX, JSON.stringify(next));
    else localStorage.removeItem(OUTBOX);
  } catch {
    /* Storage can be full or unavailable; the clips stay in memory. */
  }
  listeners.forEach((listener) => listener());
}
window.addEventListener('storage', (event) => {
  if (event.key !== OUTBOX && event.key !== null) return;
  outbox = readOutbox();
  listeners.forEach((listener) => listener());
});
export function usePendingClips() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => outbox);
}
// Pending clips with their text opened, newest first, in the shape of a saved one.
export async function revealPending(items: PendingClip[]): Promise<(Clip & { pending: PendingClip })[]> {
  const opened = await reveal(items.map((item) => item.text));
  return items
    .map((item, index) => ({
      id: item.id,
      text: opened[index],
      key_id: sealedTextKeyId(item.text),
      source_id: item.sourceId,
      source_title: item.sourceTitle ?? null,
      pinned: false,
      created_at: item.createdAt,
      file: item.file ?? null,
      pending: item,
    }))
    .reverse();
}

export function rememberClipKey(value: string | null) {
  keyId = value;
}
async function clipKey(refresh = false): Promise<string | null> {
  if (keyId === undefined && !refresh) keyId = (await cachedApi<ClipList>('/api/clips'))?.keyId;
  if (keyId === undefined || refresh)
    keyId = (await api<{ keyId: string | null }>('/api/clips/key')).keyId;
  return keyId;
}
// Plain text in the form the current setting asks for.
async function seal(text: string, target: string | null) {
  return target ? (await sealString(target, text))! : text;
}
async function plain(text: string) {
  return isSealedText(text) ? openText(await keyOrThrow(sealedTextKeyId(text)!), text) : text;
}

export async function addClip(
  text: string,
  source: { id: string; title: string } | null = null,
  // Restoring a deleted clip reuses its ID, time and image.
  restore?: { id: string; createdAt: number; file?: Clip['file'] },
  image?: Blob & { name?: string },
) {
  const value = text.replace(/\r\n?/g, '\n').trim();
  const file = restore?.file ?? (image ? await uploadImage(image) : null);
  if (!value && !file) throw new Error('请先输入内容。');
  if (value.length > CLIP_CHARS) throw new Error(`每条最多 ${CLIP_CHARS} 个字。`);
  // Offline, the setting last seen here decides; the server checks it on send.
  // An image was just sealed for the current one.
  const target = file ? file.key_id : await clipKey().catch(() => keyId ?? null);
  const item: PendingClip = {
    id: restore?.id ?? crypto.randomUUID(),
    text: value ? await seal(value, target) : '',
    sourceId: source?.id ?? null,
    sourceTitle: source?.title ?? null,
    createdAt: restore?.createdAt ?? Date.now(),
    file,
  };
  writeOutbox([...outbox, item]);
  void flushClips();
  return item;
}
async function uploadImage(image: Blob & { name?: string }): Promise<NonNullable<Clip['file']>> {
  if (isOffline()) throw new Error('图片需要联网后才能存入随手记。');
  const { bytes, mime } = await plainUpload(image);
  if (!CLIP_IMAGE_MIME.test(mime))
    throw new Error('只支持 PNG、JPEG、GIF、WebP 或 AVIF 图片。');
  if (bytes.byteLength > CLIP_IMAGE_BYTES)
    throw new Error(`图片最多 ${CLIP_IMAGE_BYTES / 1_000_000} MB。`);
  const target = await clipKey(true);
  const name = image.name || `随手记.${mime.split('/')[1]}`;
  const saved = target
    ? await uploadSealed(bytes, name, mime, target)
    : await upload(new File([bytes], name, { type: mime }));
  return { id: saved.id, name: saved.name, mime: saved.mime, size: saved.size, key_id: target };
}
export function discardPending(id: string) {
  writeOutbox(outbox.filter((item) => item.id !== id));
}

let flushing: Promise<void> | null = null;
let again = false;
// Sends the outbox in order; stops at the first clip that cannot go yet.
// A call during a send makes it go round once more for clips added meanwhile.
export function flushClips(): Promise<void> {
  if (flushing) {
    again = true;
    return flushing;
  }
  flushing = sendAll().finally(() => {
    flushing = null;
  });
  return flushing;
}
// Open lists reload once per run, however many clips it sent.
async function sendAll() {
  let delivered = false;
  try {
    for (;;) {
      again = false;
      for (const item of [...outbox]) {
        if (!outbox.some((entry) => entry.id === item.id)) continue;
        const result = await send(item);
        if (result === 'sent') delivered = true;
        if (result === 'stop') return;
      }
      if (!again) return;
    }
  } finally {
    if (delivered) sent.forEach((listener) => listener());
  }
}
const sent = new Set<() => void>();
// Called after a clip reaches the server, so open lists can reload.
export function onClipsSent(listener: () => void) {
  sent.add(listener);
  return () => void sent.delete(listener);
}
// 'stop' when it cannot go yet, which holds back the rest.
async function send(item: PendingClip): Promise<'sent' | 'kept' | 'stop'> {
  let current = item;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await api<Clip>(
        '/api/clips',
        'POST',
        {
          id: current.id,
          text: current.text,
          sourceId: current.sourceId,
          createdAt: current.createdAt,
          blobId: current.file?.id ?? null,
        },
        current.id,
      );
      writeOutbox(outbox.filter((entry) => entry.id !== item.id));
      return 'sent';
    } catch (error) {
      if (uncertainFailure(error)) return 'stop';
      // An image sealed for the old setting would have to be uploaded again.
      if (
        attempt === 0 &&
        !current.file &&
        error instanceof ApiError &&
        error.code === 'ENCRYPTION_CHANGED'
      ) {
        // The setting changed elsewhere: seal for the new one (needs the old key if sealed).
        try {
          const text = await seal(await plain(current.text), await clipKey(true));
          current = { ...current, text, error: undefined };
          writeOutbox(outbox.map((entry) => (entry.id === item.id ? current : entry)));
          continue;
        } catch (reason) {
          mark(item.id, (reason as Error).message);
          return 'stop';
        }
      }
      // A definite refusal: keep it for the user, and go on with the rest.
      mark(item.id, (error as Error).message);
      return 'kept';
    }
  }
  return 'kept';
}
function mark(id: string, error: string) {
  writeOutbox(outbox.map((entry) => (entry.id === id ? { ...entry, error } : entry)));
}
window.addEventListener('note:reconnected', () => void flushClips());
// Any page's button and the Q shortcut open the panel.
export const openClips = () => window.dispatchEvent(new Event('note:clips'));

async function writeImage(id: string, bytes: Uint8Array) {
  await proxyReady();
  const response = await fetch(`/api/clips/objects/${id}`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'x-idempotency-key': crypto.randomUUID() },
    body: new Uint8Array(bytes),
  });
  await parse(response);
}
// Switches the clip key (null for plain text), then re-seals every saved
// clip and image here. Every key they use now must be unlocked. Run again
// with the current key, it finishes what an interrupted run left.
export async function setClipEncryption(target: string | null, progress?: (done: number) => void) {
  const { readObject, plainOf } = await import('./encryption-sync');
  await api('/api/clips/encryption', 'PUT', { keyId: target, items: [] });
  keyId = target;
  const all: Clip[] = [];
  let list = await api<ClipList>('/api/clips');
  all.push(...list.pinned, ...list.items);
  while (list.next) {
    list = await api<ClipList>(`/api/clips?before=${encodeURIComponent(list.next)}`);
    all.push(...list.items);
  }
  // Responses arrive opened while the keys are unlocked.
  const texts: { id: string; text: string }[] = [];
  for (const clip of all) {
    if (clip.key_id === target) continue;
    if (clip.key_id) await keyOrThrow(clip.key_id);
    texts.push({ id: clip.id, text: clip.text ? await seal(clip.text, target) : '' });
  }
  const images = all.flatMap((clip) =>
    clip.file && clip.file.key_id !== target ? [clip.file.id] : [],
  );
  let done = 0;
  while (texts.length) {
    const batch = texts.splice(0, 50);
    await api('/api/clips/encryption', 'PUT', { keyId: target, items: batch });
    done += batch.length;
    progress?.(done);
  }
  // A few images at a time: each is read, re-sealed and written back whole.
  const reseal = async () => {
    for (let id = images.shift(); id; id = images.shift()) {
      const plain = await plainOf(await readObject(id));
      await writeImage(id, target ? await sealData(target, plain) : plain);
      progress?.(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, images.length) }, reseal));
  // Clips still waiting here follow the new setting too.
  for (const item of outbox) {
    if (item.file || sealedTextKeyId(item.text) === target) continue;
    try {
      const text = item.text ? await seal(await plain(item.text), target) : '';
      writeOutbox(outbox.map((entry) => (entry.id === item.id ? { ...entry, text } : entry)));
    } catch {
      /* Sent later, it is re-sealed on the server's refusal. */
    }
  }
}
