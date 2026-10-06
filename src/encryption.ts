import {
  fromBase64Url,
  isSealedText,
  keyChain,
  openBytes,
  openText,
  sealBytes,
  sealedKeyId,
  sealedTextKeyId,
  sealText,
  sniffMime,
  type Bytes,
} from '../shared/encryption';
import type { Crumb } from '../shared/types';
import { unlockedKey } from './keyring';

// Decrypting what the server sends and sealing what goes back. Nothing here
// talks to the server; api.ts does, and keeps sealed copies for the offline
// cache (a revealed note keeps its `sealed` field, see offline-cache.ts).
export class LockedError extends Error {
  status = 423;
  code = 'ENCRYPTION_LOCKED';
  constructor(public keyId: string | null = null) {
    super('此内容已加密，请先输入密码解锁。');
  }
}
export async function keyOrThrow(keyId: string): Promise<CryptoKey> {
  const key = await unlockedKey(keyId);
  if (!key) throw new LockedError(keyId);
  return key;
}

// What the device has learnt about nodes and files from responses: the key a
// node's content uses, the keys on its path, and which files are sealed.
const scopes = new Map<string, string | null>();
const chains = new Map<string, string[]>();
const sealedFiles = new Map<string, { name: string; mime: string }>();
export const knownScope = (id: string) => scopes.get(id);
export const knownChain = (id: string) => chains.get(id);
export function rememberScope(id: string, keyId: string | null, chain?: string[]) {
  scopes.set(id, keyId);
  if (chain) chains.set(id, chain);
}
export function forgetScope(id?: string) {
  if (!id) {
    scopes.clear();
    chains.clear();
    return;
  }
  scopes.delete(id);
  chains.delete(id);
}
export const sealedFile = (id: string) => sealedFiles.get(id);
function learn(value: Record<string, unknown>) {
  if (typeof value.id !== 'string') return;
  if ('parent_id' in value && 'kind' in value && 'key_id' in value)
    scopes.set(value.id, (value.key_id as string | null) ?? null);
  if (Array.isArray(value.breadcrumbs))
    chains.set(value.id, keyChain(value.breadcrumbs as Crumb[]));
  if ('mime' in value && 'size' in value && typeof value.key_id === 'string')
    sealedFiles.set(value.id, { name: String(value.name ?? ''), mime: String(value.mime) });
}

async function openValue(value: string): Promise<string> {
  const keyId = sealedTextKeyId(value);
  const key = keyId ? await unlockedKey(keyId) : null;
  if (!key) return '';
  return openText(key, value).catch(() => '');
}
// A copy of a response with sealed values opened: sealed D1 fields anywhere,
// a note's body (or `locked` with its key) and an encrypted annotation list.
// The original is left as it is, since it may be on its way to the cache.
export async function reveal<T>(value: T): Promise<T> {
  return (await walk(value)) as T;
}
async function walk(value: unknown): Promise<unknown> {
  if (typeof value === 'string') return isSealedText(value) ? openValue(value) : value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) out.push(await walk(item));
    return out;
  }
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = await walk(item);
  learn(out);
  if (typeof out.sealed === 'string') {
    const bytes = fromBase64Url(out.sealed);
    const keyId = sealedKeyId(bytes);
    const key = keyId ? await unlockedKey(keyId) : null;
    let text: string | null = null;
    if (key)
      text = new TextDecoder().decode(await openBytes(key, bytes).catch(() => new Uint8Array()));
    if ('content' in out) {
      if (text === null) out.locked = keyId ?? 'unknown';
      else out.content = text;
    } else if ('annotations' in out) {
      if (text === null) out.locked = keyId ?? 'unknown';
      else
        out.annotations =
          (JSON.parse(text || '{}') as { annotations?: unknown[] }).annotations ?? [];
    }
  }
  return out;
}

export async function sealString(keyId: string, text: string | null | undefined) {
  return text ? sealText(await keyOrThrow(keyId), keyId, text) : (text ?? null);
}
export async function sealData(keyId: string, bytes: Uint8Array): Promise<Bytes> {
  return sealBytes(await keyOrThrow(keyId), keyId, bytes);
}
// A file as read from the server or the offline cache, decrypted when sealed.
export async function openBlob(blob: Blob, type = ''): Promise<Blob> {
  // (A copy read back from IndexedDB in tests may not be a real Blob.)
  if (!(blob instanceof Blob) || blob.size < 64) return blob;
  const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  const keyId = sealedKeyId(head);
  if (!keyId) return blob;
  const plain = await openBytes(await keyOrThrow(keyId), new Uint8Array(await blob.arrayBuffer()));
  return new Blob([plain], { type: sniffMime(plain, type || 'application/octet-stream') });
}
// Plain bytes of a local file to upload into an encrypted place: SVG is
// cleaned here, as the server cannot see inside.
export async function plainUpload(file: Blob): Promise<{ bytes: Bytes; mime: string }> {
  let bytes = new Uint8Array(await file.arrayBuffer());
  let mime = sniffMime(bytes);
  if (mime === 'image/svg+xml' || file.type === 'image/svg+xml') {
    const { sanitizeSvg } = await import('../shared/svg');
    bytes = new TextEncoder().encode(sanitizeSvg(bytes));
    mime = 'image/svg+xml';
  }
  return { bytes, mime };
}
