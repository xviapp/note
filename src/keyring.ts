import {
  ENCRYPTION_ITERATIONS,
  exportContentKey,
  importContentKey,
  KEY_ID,
  keyCheck,
  newContentKey,
  newSalt,
  passwordKey,
  toBase64Url,
  unwrapContentKey,
  verifyKeyCheck,
  wrapContentKey,
  type KeyRecord,
} from '../shared/encryption';

// Content keys unlocked on this device. A key is unwrapped with its password
// here and never sent anywhere except with an AI request (see api.ts). How
// long it stays unlocked is the policy chosen when unlocking:
// - session: memory only, gone on reload or when the app closes;
// - idle: locks after so many minutes without use;
// - days: locks a fixed time after unlocking;
// - forever: until locked by hand, signing out or a password change.
export type KeepPolicy =
  | { kind: 'session' }
  | { kind: 'idle'; minutes: number }
  | { kind: 'days'; days: number }
  | { kind: 'forever' };
export const KEEP_OPTIONS: { label: string; policy: KeepPolicy }[] = [
  { label: '仅本次（关闭后锁定）', policy: { kind: 'session' } },
  { label: '闲置 5 分钟后锁定', policy: { kind: 'idle', minutes: 5 } },
  { label: '闲置 15 分钟后锁定', policy: { kind: 'idle', minutes: 15 } },
  { label: '闲置 1 小时后锁定', policy: { kind: 'idle', minutes: 60 } },
  { label: '记住 1 天', policy: { kind: 'days', days: 1 } },
  { label: '记住 7 天', policy: { kind: 'days', days: 7 } },
  { label: '记住 30 天', policy: { kind: 'days', days: 30 } },
  { label: '一直记住（手动锁定）', policy: { kind: 'forever' } },
];
export const policyKey = (policy: KeepPolicy) =>
  policy.kind === 'idle'
    ? `idle:${policy.minutes}`
    : policy.kind === 'days'
      ? `days:${policy.days}`
      : policy.kind;
export const policyLabel = (policy: KeepPolicy) =>
  KEEP_OPTIONS.find((option) => policyKey(option.policy) === policyKey(policy))?.label ?? '';

interface Entry {
  id: string;
  key: CryptoKey;
  // The wrapped key it was unlocked from: a changed password locks it.
  wrapped: string;
  policy: KeepPolicy;
  unlockedAt: number;
  usedAt: number;
}
const POLICY_KEY = 'note:key-policy';
const CATALOG_KEY = 'note:key-catalog';
const unlocked = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;

export function defaultPolicy(): KeepPolicy {
  try {
    const value = localStorage.getItem(POLICY_KEY);
    const found = KEEP_OPTIONS.find((option) => policyKey(option.policy) === value);
    if (found) return found.policy;
  } catch {
    /* Storage can be unavailable. */
  }
  return { kind: 'idle', minutes: 15 };
}
export function setDefaultPolicy(policy: KeepPolicy) {
  try {
    localStorage.setItem(POLICY_KEY, policyKey(policy));
  } catch {
    /* Optional preference. */
  }
  emit();
}
function emit() {
  version++;
  listeners.forEach((listener) => listener());
}
export function subscribeKeys(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export const keysVersion = () => version;

function expired(entry: Entry, now = Date.now()) {
  const { policy } = entry;
  if (policy.kind === 'idle') return now - entry.usedAt > policy.minutes * 60_000;
  if (policy.kind === 'days') return now - entry.unlockedAt > policy.days * 86_400_000;
  return false;
}

// Keys kept across reloads live in their own IndexedDB database, apart from the
// offline cache, as CryptoKey objects.
let database: Promise<IDBDatabase> | undefined;
function openDatabase() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('yejian-keys', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
  }));
}
async function store(
  action: (keys: IDBObjectStore) => IDBRequest | void,
  mode: IDBTransactionMode,
) {
  const db = await openDatabase();
  return new Promise<unknown>((resolve, reject) => {
    const tx = db.transaction('keys', mode);
    const request = action(tx.objectStore('keys'));
    tx.oncomplete = () => resolve(request?.result);
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}
const persist = (entry: Entry) =>
  entry.policy.kind === 'session'
    ? Promise.resolve()
    : store((keys) => keys.put(entry), 'readwrite').catch(() => {});
const forget = (id?: string) =>
  store((keys) => (id ? keys.delete(id) : keys.clear()), 'readwrite').catch(() => {});

const ready = (async () => {
  if (typeof indexedDB === 'undefined') return;
  try {
    const saved = ((await store((keys) => keys.getAll(), 'readonly')) ?? []) as Entry[];
    for (const entry of saved)
      if (expired(entry)) void forget(entry.id);
      else unlocked.set(entry.id, entry);
    if (saved.length) emit();
  } catch {
    /* Keys stay locked when the database cannot be read. */
  }
})();
export const keyringReady = () => ready;

// Locks keys whose time is up; the page re-locks what it shows.
function sweep() {
  let changed = false;
  for (const entry of unlocked.values())
    if (expired(entry)) {
      unlocked.delete(entry.id);
      void forget(entry.id);
      changed = true;
    }
  if (changed) emit();
}
if (typeof window !== 'undefined') {
  window.setInterval(sweep, 30_000);
  document.addEventListener('visibilitychange', sweep);
  // A lost session (see api.ts and offline-cache.ts) locks every key.
  window.addEventListener('note:unauthenticated', () => lockAll());
}

export function isUnlocked(id: string): boolean {
  const entry = unlocked.get(id);
  return !!entry && !expired(entry);
}
export const unlockedIds = () => [...unlocked.keys()].filter(isUnlocked);
export const unlockedEntries = () =>
  [...unlocked.values()]
    .filter((entry) => !expired(entry))
    .map(({ id, policy, unlockedAt, usedAt }) => ({ id, policy, unlockedAt, usedAt }));

const touched = new Map<string, number>();
// The key to read or write with, or null when locked. Using a key counts as
// activity for the idle policy.
export async function unlockedKey(id: string): Promise<CryptoKey | null> {
  await ready;
  const entry = unlocked.get(id);
  if (!entry) return null;
  if (expired(entry)) {
    sweep();
    return null;
  }
  const now = Date.now();
  entry.usedAt = now;
  if (entry.policy.kind === 'idle' && now - (touched.get(id) ?? 0) > 30_000) {
    touched.set(id, now);
    void persist(entry);
  }
  return entry.key;
}
// `id.key` pairs for the request header of an AI feature.
export async function keyHeader(ids: string[]): Promise<string> {
  const parts: string[] = [];
  for (const id of ids) {
    const key = await unlockedKey(id);
    if (key) parts.push(`${id}.${toBase64Url(await exportContentKey(key))}`);
  }
  return parts.join(',');
}

// Wrapped keys are not secret; a copy here lets a key be unlocked offline.
export function cachedCatalog(): KeyRecord[] {
  try {
    const value = JSON.parse(localStorage.getItem(CATALOG_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}
export function rememberCatalog(keys: KeyRecord[]) {
  try {
    localStorage.setItem(CATALOG_KEY, JSON.stringify(keys));
  } catch {
    /* Optional copy for offline unlocking. */
  }
}
// Keys whose password was changed elsewhere lock here too.
export function syncCatalog(keys: KeyRecord[]) {
  rememberCatalog(keys);
  const wrapped = new Map(keys.map((key) => [key.id, key.wrapped]));
  let changed = false;
  for (const entry of unlocked.values())
    if (wrapped.get(entry.id) !== entry.wrapped) {
      unlocked.delete(entry.id);
      void forget(entry.id);
      changed = true;
    }
  if (changed) emit();
}
export async function refreshCatalog(): Promise<KeyRecord[]> {
  await ready;
  const response = await fetch('/api/encryption/keys', { credentials: 'same-origin' });
  if (!response.ok) throw new Error('密码记录暂时无法读取，请稍后重试。');
  const { keys } = (await response.json()) as { keys: KeyRecord[] };
  syncCatalog(keys);
  return keys;
}
async function keyRecord(id: string, refresh = false): Promise<KeyRecord> {
  let record = refresh ? undefined : cachedCatalog().find((key) => key.id === id);
  if (!record) record = (await refreshCatalog().catch(() => [])).find((key) => key.id === id);
  if (!record) throw new Error('找不到这个密码的记录，请联网后重试。');
  return record;
}

function remember(id: string, wrapped: string, key: CryptoKey, policy: KeepPolicy) {
  const now = Date.now();
  const entry: Entry = { id, key, wrapped, policy, unlockedAt: now, usedAt: now };
  unlocked.set(id, entry);
  void (policy.kind === 'session' ? forget(id) : persist(entry));
  emit();
}
async function unwrap(record: KeyRecord, password: string): Promise<CryptoKey> {
  const wrapping = await passwordKey(password, record.salt, record.iterations);
  const key = await importContentKey(await unwrapContentKey(wrapping, record.wrapped), true);
  if (!(await verifyKeyCheck(key, record.check_value))) throw new Error('密码不正确。');
  return key;
}
export async function unlock(id: string, password: string, policy = defaultPolicy()) {
  let record = await keyRecord(id);
  let key: CryptoKey;
  try {
    key = await unwrap(record, password);
  } catch (error) {
    // The password may have been changed on another device.
    const fresh = await keyRecord(id, true).catch(() => record);
    if (fresh.wrapped === record.wrapped) throw error;
    record = fresh;
    key = await unwrap(record, password);
  }
  remember(id, record.wrapped, key, policy);
}
// A new key for a password, unlocked here. The record goes to the server.
export async function createKey(password: string, policy = defaultPolicy()) {
  const id = crypto.randomUUID();
  const key = await newContentKey();
  const salt = newSalt();
  const wrapping = await passwordKey(password, salt, ENCRYPTION_ITERATIONS);
  const record: KeyRecord = {
    id,
    salt,
    iterations: ENCRYPTION_ITERATIONS,
    wrapped: await wrapContentKey(wrapping, await exportContentKey(key)),
    check_value: await keyCheck(key),
    created_at: Date.now(),
  };
  return { record, commit: () => remember(id, record.wrapped, key, policy) };
}
// The same content key under a new password: nothing is re-encrypted.
export async function rewrap(id: string, current: string | null, password: string) {
  const record = await keyRecord(id, true);
  const key = current === null ? await unlockedKey(id) : await unwrap(record, current);
  if (!key) throw new Error('请输入当前密码。');
  const salt = newSalt();
  const wrapping = await passwordKey(password, salt, ENCRYPTION_ITERATIONS);
  const wrapped = await wrapContentKey(wrapping, await exportContentKey(key));
  return {
    fields: { salt, iterations: ENCRYPTION_ITERATIONS, wrapped },
    // After the server accepts it, this device stays unlocked.
    commit: () => {
      const entry = unlocked.get(id);
      if (entry) {
        entry.wrapped = wrapped;
        void persist(entry);
      }
    },
  };
}
export function lock(id: string) {
  unlocked.delete(id);
  void forget(id);
  emit();
}
// Signing out or losing the session locks every key on this device.
export function lockAll() {
  unlocked.clear();
  void forget();
  try {
    localStorage.removeItem(CATALOG_KEY);
  } catch {
    /* Storage can be unavailable. */
  }
  emit();
}
export const isKeyId = (value: unknown): value is string =>
  typeof value === 'string' && KEY_ID.test(value);
