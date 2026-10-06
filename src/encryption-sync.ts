import {
  isSealedText,
  openBytes,
  openText,
  PLAN_LIMIT,
  sealedKeyId,
  sealedTextKeyId,
  type Bytes,
  type EncryptionPlan,
  type PlanField,
  type PlanObject,
} from '../shared/encryption';
import { annotationSearchText, type Annotation } from '../shared/annotations';
import { rewriteBackupText } from '../shared/backup';
import { markdownMetadata } from '../shared/projects';
import { api, parse } from './api';
import { forgetScope, keyOrThrow, LockedError, sealData, sealString } from './encryption';
import { removeCachedNote } from './offline-cache';
import { proxyReady } from './proxy';

export interface SyncResult {
  done: number;
  // Keys that must be unlocked to read what is left.
  locked: string[];
  failed: string[];
}
type Progress = (done: number) => void;

async function readObject(id: string): Promise<Bytes> {
  await proxyReady();
  const response = await fetch(`/api/files/${encodeURIComponent(id)}`, {
    credentials: 'same-origin',
  });
  if (!response.ok) {
    await parse(response);
    throw new Error('文件暂时无法读取。');
  }
  return new Uint8Array(await response.arrayBuffer());
}
async function plainOf(bytes: Bytes): Promise<Bytes> {
  const keyId = sealedKeyId(bytes);
  return keyId ? openBytes(await keyOrThrow(keyId), bytes) : bytes;
}
async function writeObject(root: string, id: string, bytes: Uint8Array) {
  await proxyReady();
  const response = await fetch(`/api/nodes/${root}/encryption/objects/${id}`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'x-idempotency-key': crypto.randomUUID() },
    body: new Uint8Array(bytes),
  });
  await parse(response);
}
const reseal = async (target: string | null, plain: Bytes) =>
  target ? sealData(target, plain) : plain;
async function resealText(target: string | null, value: string) {
  let text = value;
  if (isSealedText(value)) text = await openText(await keyOrThrow(sealedTextKeyId(value)!), value);
  return target ? ((await sealString(target, text)) ?? '') : text;
}

// One object re-sealed for its place, plus what D1 derives from its text.
async function syncObject(root: string, object: PlanObject) {
  const plain = await plainOf(await readObject(object.id));
  if (object.target) await keyOrThrow(object.target);
  await writeObject(root, object.id, await reseal(object.target, plain));
  const text = () => new TextDecoder().decode(plain);
  const fields: Record<string, unknown>[] = [];
  if (object.kind === 'annotation' && !object.target) {
    const list = (JSON.parse(text()) as { annotations?: Annotation[] }).annotations ?? [];
    fields.push({
      table: 'annotations',
      node_id: object.node_id,
      search_text: annotationSearchText(list),
    });
  }
  if (object.kind === 'body' && object.current && object.version_id) {
    const metadata = markdownMetadata(text());
    const seal = (value: string | null) =>
      object.target ? sealString(object.target, value) : Promise.resolve(value);
    fields.push({
      table: 'nodes',
      node_id: object.node_id,
      version_id: object.version_id,
      title: await seal(metadata.title),
      status: await seal(metadata.status),
      excerpt: await seal(metadata.summary),
    });
  }
  if (fields.length) await api(`/api/nodes/${root}/encryption/fields`, 'POST', { fields });
}
async function syncField(field: PlanField) {
  if (field.table === 'translations')
    return {
      table: 'translations',
      id: field.id,
      node_id: field.node_id,
      excerpt: await resealText(field.target, field.values.excerpt),
    };
  let questions: string[] = [];
  try {
    questions = JSON.parse(field.values.questions);
  } catch {
    /* Treated as none. */
  }
  return {
    table: 'book_pages',
    node_id: field.node_id,
    summary: await resealText(field.target, field.values.summary),
    questions: await Promise.all(questions.map((value) => resealText(field.target, value))),
  };
}
function record(result: SyncResult, error: unknown, name: string) {
  if (error instanceof LockedError && error.keyId) {
    if (!result.locked.includes(error.keyId)) result.locked.push(error.keyId);
  } else result.failed.push(`${name}：${(error as Error).message}`);
}

// Brings everything below `root` in line with its encryption settings: each
// object is read, decrypted with the key it has and sealed with the key its
// place wants (or left plain), then replaced under the same ID. Objects whose
// current key is locked are reported, so the caller can ask for it and retry.
export async function syncEncryption(root: string, onProgress?: Progress): Promise<SyncResult> {
  const result: SyncResult = { done: 0, locked: [], failed: [] };
  forgetScope();
  let after = '';
  for (let page = 0; ; page++) {
    const plan = await api<EncryptionPlan>(
      `/api/nodes/${root}/encryption/plan${after ? `?after=${after}` : ''}`,
    );
    if (!page && plan.fields.length) {
      const fields = [];
      for (const field of plan.fields)
        try {
          fields.push(await syncField(field));
        } catch (error) {
          record(result, error, '摘要');
        }
      for (let i = 0; i < fields.length; i += 100)
        await api(`/api/nodes/${root}/encryption/fields`, 'POST', {
          fields: fields.slice(i, i + 100),
        });
    }
    for (const object of plan.objects) {
      try {
        await syncObject(root, object);
        result.done++;
        onProgress?.(result.done);
      } catch (error) {
        record(result, error, object.name);
      }
    }
    if (plan.objects.length < PLAN_LIMIT) break;
    after = plan.objects.at(-1)!.id;
  }
  // Copies on this device were saved under the old settings.
  forgetScope();
  if (result.done) await removeCachedNote(root).catch(() => {});
  return result;
}

// After a backup is restored, sealed text still names the archive's IDs.
// Each is decrypted, rewritten with the restore's mapping and sealed again.
export async function repairRestored(
  root: string,
  mapping: Record<string, string>,
  onProgress?: Progress,
): Promise<SyncResult> {
  const result: SyncResult = { done: 0, locked: [], failed: [] };
  let after = '';
  while (true) {
    const plan = await api<EncryptionPlan>(
      `/api/nodes/${root}/encryption/plan?sealed=1${after ? `&after=${after}` : ''}`,
    );
    for (const object of plan.objects) {
      try {
        const bytes = await readObject(object.id);
        const keyId = sealedKeyId(bytes);
        if (!keyId) continue;
        const text = new TextDecoder().decode(await openBytes(await keyOrThrow(keyId), bytes));
        const rewritten = rewriteBackupText(text, mapping);
        if (rewritten !== text)
          await writeObject(
            root,
            object.id,
            await sealData(keyId, new TextEncoder().encode(rewritten)),
          );
        result.done++;
        onProgress?.(result.done);
      } catch (error) {
        record(result, error, object.name);
      }
    }
    if (plan.objects.length < PLAN_LIMIT) break;
    after = plan.objects.at(-1)!.id;
  }
  await removeCachedNote(root).catch(() => {});
  return result;
}
