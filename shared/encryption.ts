// Local encryption. Objects in R2 (and a few short D1 fields derived from them)
// are sealed with AES-256-GCM under a random content key. The content key is
// stored only wrapped by a key derived from the password, so the password and
// the unwrapped key never leave a device, except that an AI request may carry
// the content key for the Worker to use in memory (see worker/encryption.ts).
//
// Sealed object: "XVE1" | key ID (36 ASCII) | nonce prefix (8) | chunks.
// Each chunk holds up to 64 KiB of plain text plus its 16-byte tag. The nonce
// is the prefix and the chunk index; the header and a final-chunk flag are
// authenticated, so chunks cannot be reordered, dropped or truncated.
export const SEALED_MAGIC = 'XVE1';
export const SEALED_HEADER = 48;
const CHUNK = 65_536;
const TAG = 16;
// Short D1 values (summaries, excerpts) are sealed objects in base64url after
// this prefix; an invisible separator keeps it out of anything typed.
export const SEALED_PREFIX = '⁣xve1:';
export const KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const KEY_HEADER = 'x-note-keys';
export const ENCRYPTION_ITERATIONS = 600_000;
export const MIN_ENCRYPTION_PASSWORD = 6;

export type Bytes = Uint8Array<ArrayBuffer>;
export interface KeyRecord {
  id: string;
  salt: string;
  iterations: number;
  wrapped: string;
  check_value: string;
  created_at: number;
}
// A node's own setting: inherit (null), plain text below it, or a key.
export type EncryptionSetting = null | 'none' | string;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export class DecryptionError extends Error {
  constructor(message = '内容无法解密，密码或数据可能已损坏。') {
    super(message);
  }
}

export function toBase64Url(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
export function fromBase64Url(text: string): Bytes {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const sealedSize = (plain: number) =>
  SEALED_HEADER + Math.max(1, Math.ceil(plain / CHUNK)) * TAG + plain;
export function plainSize(sealed: number) {
  const body = sealed - SEALED_HEADER;
  return Math.max(0, body - Math.max(1, Math.ceil(body / (CHUNK + TAG))) * TAG);
}

// The key a sealed object names in its header, or null for plain content.
export function sealedKeyId(bytes: Uint8Array): string | null {
  if (bytes.length < SEALED_HEADER + TAG) return null;
  for (let i = 0; i < 4; i++) if (bytes[i] !== SEALED_MAGIC.charCodeAt(i)) return null;
  const id = String.fromCharCode(...bytes.subarray(4, 40));
  return KEY_ID.test(id) ? id : null;
}
function nonce(header: Uint8Array, index: number): Bytes {
  const iv = new Uint8Array(12);
  iv.set(header.subarray(40, 48));
  new DataView(iv.buffer).setUint32(8, index);
  return iv;
}
function aad(header: Uint8Array, final: boolean): Bytes {
  const data = new Uint8Array(SEALED_HEADER + 1);
  data.set(header);
  data[SEALED_HEADER] = final ? 1 : 0;
  return data;
}

export async function sealBytes(key: CryptoKey, keyId: string, plain: Uint8Array): Promise<Bytes> {
  if (!KEY_ID.test(keyId)) throw new Error('密钥标识不正确。');
  const out = new Uint8Array(sealedSize(plain.length));
  out.set(encoder.encode(SEALED_MAGIC), 0);
  out.set(encoder.encode(keyId), 4);
  crypto.getRandomValues(out.subarray(40, 48));
  const header = out.slice(0, SEALED_HEADER);
  const chunks = Math.max(1, Math.ceil(plain.length / CHUNK));
  let offset = SEALED_HEADER;
  for (let index = 0; index < chunks; index++) {
    const part = plain.slice(index * CHUNK, Math.min(plain.length, (index + 1) * CHUNK));
    const sealed = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce(header, index),
        additionalData: aad(header, index === chunks - 1),
      },
      key,
      part,
    );
    out.set(new Uint8Array(sealed), offset);
    offset += sealed.byteLength;
  }
  return out;
}
export async function openBytes(key: CryptoKey, sealed: Uint8Array): Promise<Bytes> {
  if (!sealedKeyId(sealed)) throw new DecryptionError();
  const header = sealed.slice(0, SEALED_HEADER);
  const out = new Uint8Array(plainSize(sealed.length));
  let offset = SEALED_HEADER,
    written = 0;
  for (let index = 0; offset < sealed.length; index++) {
    const end = Math.min(sealed.length, offset + CHUNK + TAG);
    const final = end === sealed.length;
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce(header, index), additionalData: aad(header, final) },
        key,
        sealed.slice(offset, end),
      );
      out.set(new Uint8Array(plain), written);
      written += plain.byteLength;
    } catch {
      throw new DecryptionError();
    }
    offset = end;
  }
  if (written !== out.length) throw new DecryptionError();
  return out;
}

export const isSealedText = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(SEALED_PREFIX);
export async function sealText(key: CryptoKey, keyId: string, text: string): Promise<string> {
  return SEALED_PREFIX + toBase64Url(await sealBytes(key, keyId, encoder.encode(text)));
}
export async function openText(key: CryptoKey, sealed: string): Promise<string> {
  if (!isSealedText(sealed)) return sealed;
  return decoder.decode(await openBytes(key, fromBase64Url(sealed.slice(SEALED_PREFIX.length))));
}
export function sealedTextKeyId(value: unknown): string | null {
  if (!isSealedText(value)) return null;
  try {
    // 88 base64url characters cover the header and the first tag.
    return sealedKeyId(fromBase64Url(value.slice(SEALED_PREFIX.length, SEALED_PREFIX.length + 88)));
  } catch {
    return null;
  }
}

// Content keys. A key is created on a device, wrapped by the password and
// checked by a known value sealed under it.
export async function importContentKey(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
  if (raw.length !== 32) throw new DecryptionError('内容密钥格式不正确。');
  return crypto.subtle.importKey('raw', new Uint8Array(raw), 'AES-GCM', extractable, [
    'encrypt',
    'decrypt',
  ]);
}
export async function newContentKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
export async function exportContentKey(key: CryptoKey): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}
export async function passwordKey(
  password: string,
  salt: string,
  iterations: number,
): Promise<CryptoKey> {
  if (!Number.isSafeInteger(iterations) || iterations < 100_000 || iterations > 5_000_000)
    throw new DecryptionError('密码参数不正确。');
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password.normalize('NFC')),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64Url(salt), iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
async function sealSmall(key: CryptoKey, plain: Bytes): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const out = new Uint8Array(12 + sealed.length);
  out.set(iv);
  out.set(sealed, 12);
  return toBase64Url(out);
}
async function openSmall(key: CryptoKey, value: string): Promise<Bytes> {
  const bytes = fromBase64Url(value);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12)),
  );
}
export const wrapContentKey = (wrapping: CryptoKey, raw: Bytes) => sealSmall(wrapping, raw);
export async function unwrapContentKey(wrapping: CryptoKey, wrapped: string): Promise<Bytes> {
  try {
    return await openSmall(wrapping, wrapped);
  } catch {
    throw new DecryptionError('密码不正确。');
  }
}
const CHECK = encoder.encode('xvi-note:content-key');
export const keyCheck = (key: CryptoKey) => sealSmall(key, CHECK);
export async function verifyKeyCheck(key: CryptoKey, check: string): Promise<boolean> {
  try {
    const value = await openSmall(key, check);
    return value.length === CHECK.length && value.every((byte, i) => byte === CHECK[i]);
  } catch {
    return false;
  }
}
export function newSalt(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

// What a decrypted file is, from its first bytes (the server only stores the
// type the device declared).
export function sniffMime(bytes: Uint8Array, fallback = 'application/octet-stream'): string {
  const text = String.fromCharCode(...bytes.subarray(0, 64));
  if (text.startsWith('%PDF-')) return 'application/pdf';
  if (bytes[0] === 137 && text.slice(1, 4) === 'PNG') return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (text.startsWith('GIF87a') || text.startsWith('GIF89a')) return 'image/gif';
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return 'image/webp';
  if (text.slice(4, 8) === 'ftyp' && /avif|avis/.test(text.slice(8, 16))) return 'image/avif';
  if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text)) return 'image/svg+xml';
  return fallback;
}

// The keys along a path from the root, each once: what a request about the
// last node may need. 'none' stops inheritance below it.
export function keyChain(path: { encryption?: string | null }[]): string[] {
  const chain: string[] = [];
  let current: string | null = null;
  for (const part of path) {
    if (part.encryption) current = part.encryption === 'none' ? null : part.encryption;
    if (current && !chain.includes(current)) chain.push(current);
  }
  return chain;
}

// What still has to be re-sealed below a node (GET /api/nodes/:id/encryption/plan).
export interface PlanObject {
  id: string;
  kind: 'body' | 'file' | 'chat' | 'translation' | 'annotation';
  node_id: string;
  target: string | null;
  current: number;
  // For the current body of a Markdown note: its version, for summaries.
  version_id: string | null;
  key_id: string | null;
  mime: string;
  name: string;
  size: number;
}
export interface PlanField {
  table: 'book_pages' | 'translations';
  id: string;
  node_id: string;
  target: string | null;
  values: Record<string, string>;
}
export const PLAN_LIMIT = 200;
export interface EncryptionPlan {
  objects: PlanObject[];
  fields: PlanField[];
}
