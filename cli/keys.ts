import {
  importContentKey,
  openBytes,
  passwordKey,
  sealedKeyId,
  unwrapContentKey,
  verifyKeyCheck,
  DecryptionError,
  type KeyRecord,
} from '../shared/encryption.ts';
import type { Client } from './client.ts';

export type AskPassword = (label: string) => Promise<string | null>;
// Tries a password only as often as someone can correct it.
const ATTEMPTS = 3;
// Content keys unlocked for this run. They stay in memory: a CLI is asked again
// each time, so plaintext keys never rest beside the plaintext workspace.
export class Keyring {
  client: Client;
  ask: AskPassword;
  private records: Promise<Map<string, KeyRecord>> | null = null;
  private keys = new Map<string, Promise<CryptoKey | null>>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(client: Client, ask: AskPassword) {
    this.client = client;
    this.ask = ask;
  }
  private recordsById() {
    this.records ??= this.client
      .encryptionKeys()
      .then((records) => new Map(records.map((record) => [record.id, record])));
    return this.records;
  }
  private async unlock(id: string, label: string): Promise<CryptoKey | null> {
    const record = (await this.recordsById()).get(id);
    if (!record) return null;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const password = await this.ask(`输入「${label}」的加密密码（留空跳过）：`);
      if (!password) return null;
      try {
        const wrapping = await passwordKey(password, record.salt, record.iterations);
        const key = await importContentKey(await unwrapContentKey(wrapping, record.wrapped), true);
        if (await verifyKeyCheck(key, record.check_value)) return key;
      } catch (error) {
        if (!(error instanceof DecryptionError)) throw error;
      }
      console.error('密码不正确。');
    }
    return null;
  }
  // The key, asking for its password once; null when it stays locked. Questions
  // come one at a time, however many notes need a key at once.
  forKey(id: string, label: string): Promise<CryptoKey | null> {
    let key = this.keys.get(id);
    if (!key) {
      key = this.queue.then(() => this.unlock(id, label));
      this.queue = key.catch(() => {});
      this.keys.set(id, key);
    }
    return key;
  }
  // The bytes without their seal, or null when their key stays locked.
  async open(bytes: Uint8Array, label: string): Promise<Uint8Array | null> {
    const id = sealedKeyId(bytes);
    if (!id) return bytes;
    const key = await this.forKey(id, label);
    return key ? openBytes(key, bytes) : null;
  }
}
