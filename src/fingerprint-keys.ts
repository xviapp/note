import { Capacitor } from '@capacitor/core';
import type { device as Device } from './mobile';
import { defaultPolicy, StaleKeyError, unlockedRaw, unlockRaw, type KeepPolicy } from './keyring';

// Android only: content keys kept by the device behind a fingerprint, so an
// encrypted note can be unlocked without its password. The device seals each
// key with a Keystore key that needs a strong fingerprint per use; here we only
// hand keys over and check them against their password's record.
export interface FingerprintState {
  available: boolean;
  // Key ID → the wrapped key it was saved from.
  keys: Map<string, string>;
}

// A Capacitor plugin answers any property, `then` included, so it must never
// be what an async function returns: call it where it is imported.
const native = async <T,>(action: (plugin: typeof Device) => Promise<T>) =>
  action((await import('./mobile')).device);
const listeners = new Set<() => void>();
let state: FingerprintState | null = null;
let loading: Promise<FingerprintState | null> | undefined;

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function set(next: FingerprintState | null) {
  state = next;
  listeners.forEach((listener) => listener());
}
export function subscribeFingerprint(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export const fingerprintState = () => state;

export function loadFingerprint(refresh = false): Promise<FingerprintState | null> {
  if (!Capacitor.isNativePlatform()) return Promise.resolve(null);
  if (loading && !refresh) return loading;
  return (loading = (async () => {
    try {
      const { available, keys } = await native((plugin) => plugin.fingerprintKeys());
      const next = { available, keys: new Map(keys.map((key) => [key.id, key.wrapped])) };
      set(next);
      return next;
    } catch {
      return state;
    }
  })());
}

// Keeps an unlocked key for fingerprint unlocking; false when the user cancelled.
export async function saveFingerprint(id: string): Promise<boolean> {
  const unlocked = await unlockedRaw(id);
  if (!unlocked) throw new Error('请先用密码解锁。');
  const { cancelled } = await native((plugin) =>
    plugin.fingerprintKeySave({ id, wrapped: unlocked.wrapped, key: toBase64(unlocked.raw) }),
  );
  await loadFingerprint(true);
  return !cancelled;
}

// Unlocks a key by fingerprint; false when the user chose the password instead.
export async function unlockWithFingerprint(id: string, policy: KeepPolicy = defaultPolicy()) {
  const wrapped = state?.keys.get(id);
  if (!wrapped) throw new Error('未在本机启用指纹解锁，请输入密码。');
  let result: { cancelled: boolean; key?: string };
  try {
    result = await native((plugin) => plugin.fingerprintKeyOpen({ id }));
  } catch (error) {
    // The device may have dropped its keys (new fingerprints).
    await loadFingerprint(true);
    throw error;
  }
  if (result.cancelled || !result.key) return false;
  try {
    await unlockRaw(id, fromBase64(result.key), wrapped, policy);
  } catch (error) {
    // A changed password: this saved key will never match again.
    if (error instanceof StaleKeyError) await removeFingerprint(id).catch(() => {});
    throw error;
  }
  return true;
}

export async function removeFingerprint(id?: string) {
  await native((plugin) => plugin.fingerprintKeyRemove(id ? { id } : {}));
  await loadFingerprint(true);
}
