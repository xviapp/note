import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  saved: new Map<string, { wrapped: string; key: string }>(),
  open: vi.fn(),
  save: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
// The device keeps keys in memory; open() stands in for the fingerprint prompt.
// Like a Capacitor plugin, it answers any property (`then` included) with a
// native call that never returns.
vi.mock('./mobile', () => {
  const methods: Record<string, unknown> = {
    fingerprintKeys: async () => ({
      available: true,
      keys: [...mock.saved].map(([id, { wrapped }]) => ({ id, wrapped })),
    }),
    fingerprintKeySave: mock.save,
    fingerprintKeyOpen: mock.open,
    fingerprintKeyRemove: async ({ id }: { id?: string }) => {
      if (id) mock.saved.delete(id);
      else mock.saved.clear();
    },
  };
  return { device: new Proxy(methods, { get: (target, key) => target[String(key)] ?? (() => new Promise(() => {})) }) };
});
import { createKey, isUnlocked, lock, lockAll, rememberCatalog } from './keyring';
import { fingerprintState, loadFingerprint, saveFingerprint, unlockWithFingerprint } from './fingerprint-keys';

const session = { kind: 'session' } as const;
async function unlockedKey() {
  const { record, commit } = await createKey('correct horse', session);
  commit();
  rememberCatalog([record]);
  return record;
}

beforeEach(() => {
  mock.saved.clear();
  mock.save.mockReset().mockImplementation(async (options: { id: string; wrapped: string; key: string }) => {
    mock.saved.set(options.id, options);
    return { cancelled: false };
  });
  mock.open.mockReset().mockImplementation(async ({ id }: { id: string }) => ({
    cancelled: false,
    key: mock.saved.get(id)?.key,
  }));
});
afterEach(() => {
  lockAll();
  vi.unstubAllGlobals();
});

describe('fingerprint keys', () => {
  it('unlocks a locked key with the one kept by the device', async () => {
    const record = await unlockedKey();
    expect(await saveFingerprint(record.id)).toBe(true);
    expect(mock.saved.get(record.id)?.wrapped).toBe(record.wrapped);
    expect(fingerprintState()?.keys.get(record.id)).toBe(record.wrapped);

    lock(record.id);
    expect(isUnlocked(record.id)).toBe(false);
    expect(await unlockWithFingerprint(record.id, session)).toBe(true);
    expect(isUnlocked(record.id)).toBe(true);
  });

  it('stays locked when the password is chosen instead', async () => {
    const record = await unlockedKey();
    await saveFingerprint(record.id);
    lock(record.id);
    mock.open.mockResolvedValue({ cancelled: true });
    expect(await unlockWithFingerprint(record.id, session)).toBe(false);
    expect(isUnlocked(record.id)).toBe(false);
  });

  it('forgets a key whose password was changed', async () => {
    const record = await unlockedKey();
    await saveFingerprint(record.id);
    lock(record.id);
    // The catalog this device last fetched has the new password.
    const changed = { ...record, wrapped: 'changed-elsewhere' };
    rememberCatalog([changed]);
    vi.stubGlobal('fetch', async () => Response.json({ keys: [changed] }));
    await expect(unlockWithFingerprint(record.id, session)).rejects.toThrow('密码已修改，请输入新密码。');
    expect(isUnlocked(record.id)).toBe(false);
    expect(mock.saved.has(record.id)).toBe(false);
  });

  it('refuses a key that does not match its record', async () => {
    const record = await unlockedKey();
    await saveFingerprint(record.id);
    lock(record.id);
    mock.open.mockResolvedValue({ cancelled: false, key: btoa('x'.repeat(32)) });
    await expect(unlockWithFingerprint(record.id, session)).rejects.toThrow('密钥校验失败');
    expect(mock.saved.has(record.id)).toBe(false);
  });

  it('keeps nothing for a key that is not unlocked', async () => {
    const record = await unlockedKey();
    lock(record.id);
    await expect(saveFingerprint(record.id)).rejects.toThrow('请先用密码解锁。');
    expect(mock.save).not.toHaveBeenCalled();
  });

  it('asks the device to drop its keys when every key is locked', async () => {
    const dropped = vi.fn();
    window.addEventListener('note:keys-locked', dropped);
    await loadFingerprint(true);
    lockAll();
    expect(dropped).toHaveBeenCalled();
    window.removeEventListener('note:keys-locked', dropped);
  });
});
