import {
  fromBase64Url,
  importContentKey,
  KEY_HEADER,
  KEY_ID,
  openText,
  sealedKeyId,
  sealedSize,
  sealedTextKeyId,
  sealText,
  verifyKeyCheck,
  keyChain,
  PLAN_LIMIT,
  type KeyRecord,
  type PlanField,
  type PlanObject,
} from '../shared/encryption';
import { sanitizeSvg, SVG_MIME } from '../shared/svg';
import { AppError, idValue, integer, readLimited, textValue } from './http';
import { getNode, KEY_SQL, nodePath } from './library';
import { MAX_FILE_BYTES } from './storage';
import type { NoteNode } from '../shared/types';
import type { BlobRow, Env } from './types';

export const locked = () =>
  new AppError(423, '此内容已加密，请先输入密码解锁。', 'ENCRYPTION_LOCKED');

// Content keys travel only with requests the Worker must process in plain text
// (青藜, translation, books, projects). Each is checked against its stored
// check value and kept in memory for this request alone. Such a request always
// gets a key map, so a missing key reads as locked rather than misplaced.
export async function withKeys(env: Env, request: Request): Promise<Env> {
  const header = request.headers.get(KEY_HEADER);
  if (!header) return { ...env, KEYS: new Map() };
  const entries = header
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length > 16) throw new AppError(400, '密钥数量过多。');
  const parsed = entries.map((entry) => {
    const [id, raw = ''] = entry.split('.');
    if (!KEY_ID.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(raw))
      throw new AppError(400, '密钥格式不正确。');
    return { id, raw };
  });
  if (!parsed.length) return { ...env, KEYS: new Map() };
  const rows = await env.DB.prepare(
    `SELECT id,check_value FROM encryption_keys WHERE id IN (${parsed.map(() => '?').join(',')})`,
  )
    .bind(...parsed.map((entry) => entry.id))
    .all<{ id: string; check_value: string }>();
  const checks = new Map(rows.results.map((row) => [row.id, row.check_value]));
  const keys = new Map<string, CryptoKey>(),
    hashes = new Map<string, CryptoKey>();
  for (const { id, raw } of parsed) {
    const check = checks.get(id);
    if (!check) continue;
    const bytes = fromBase64Url(raw);
    const key = await importContentKey(bytes);
    if (!(await verifyKeyCheck(key, check)))
      throw new AppError(400, '密钥校验失败，请重新解锁。', 'ENCRYPTION_KEY_INVALID');
    keys.set(id, key);
    // A separate key for cache digests, derived from the content key.
    const derived = await crypto.subtle.digest(
      'SHA-256',
      new Uint8Array([...bytes, ...new TextEncoder().encode('xvi-note:digest')]),
    );
    hashes.set(
      id,
      await crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
      ]),
    );
  }
  return { ...env, KEYS: keys, HASHES: hashes };
}
export async function keyedDigest(env: Env, keyId: string, text: string) {
  const key = env.HASHES?.get(keyId);
  if (!key) throw locked();
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
}
export const hasKey = (env: Env, keyId: string) => !!env.KEYS?.has(keyId);
export function keyFor(env: Env, keyId: string): CryptoKey {
  const key = env.KEYS?.get(keyId);
  if (!key) throw locked();
  return key;
}
// The node's key must be present before any paid call is made for it.
export function requireKey(env: Env, node: Pick<NoteNode, 'key_id'>) {
  if (node.key_id) keyFor(env, node.key_id);
}
// A short value stored in D1 under the node's key.
export async function sealFor(env: Env, keyId: string | null | undefined, text: string) {
  return keyId && text ? sealText(keyFor(env, keyId), keyId, text) : text;
}
export async function openFor(env: Env, value: string): Promise<string> {
  const id = sealedTextKeyId(value);
  return id ? openText(keyFor(env, id), value) : value;
}

export async function listKeys(env: Env): Promise<{ keys: KeyRecord[] }> {
  const rows = await env.DB.prepare(
    'SELECT id,salt,iterations,wrapped,check_value,created_at FROM encryption_keys ORDER BY created_at,id',
  ).all<KeyRecord>();
  return { keys: rows.results };
}
function keyFields(data: Record<string, unknown>) {
  const encoded = (value: unknown, label: string, max: number) => {
    const text = textValue(value, label, max);
    if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new AppError(400, `${label}不正确。`);
    return text;
  };
  return {
    salt: encoded(data.salt, '密码盐', 64),
    iterations: integer(data.iterations, '密码参数', 100_000, 5_000_000),
    wrapped: encoded(data.wrapped, '加密密钥', 200),
  };
}
// A key generated on a device, stored wrapped by its password.
export async function createKey(env: Env, data: Record<string, unknown>): Promise<KeyRecord> {
  if (typeof data.id !== 'string' || !KEY_ID.test(data.id))
    throw new AppError(400, '密钥标识不正确。');
  const fields = keyFields(data);
  const check = textValue(data.check_value, '密钥校验值', 200);
  await env.DB.prepare(
    `INSERT INTO encryption_keys(id,salt,iterations,wrapped,check_value,created_at) VALUES(?,?,?,?,?,?)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(data.id, fields.salt, fields.iterations, fields.wrapped, check, Date.now())
    .run();
  const row = await env.DB.prepare('SELECT * FROM encryption_keys WHERE id=?')
    .bind(data.id)
    .first<KeyRecord>();
  if (!row || row.check_value !== check) throw new AppError(409, '密钥标识已被使用。');
  return row;
}
// Changing a password rewraps the same content key; nothing is re-encrypted.
export async function rewrapKey(
  env: Env,
  id: string,
  data: Record<string, unknown>,
): Promise<KeyRecord> {
  const fields = keyFields(data);
  const row = await env.DB.prepare(
    'UPDATE encryption_keys SET salt=?,iterations=?,wrapped=? WHERE id=? RETURNING *',
  )
    .bind(fields.salt, fields.iterations, fields.wrapped, id)
    .first<KeyRecord>();
  if (!row) throw new AppError(404, '密钥不存在。');
  return row;
}

export async function setEncryption(
  env: Env,
  id: string,
  data: Record<string, unknown>,
): Promise<NoteNode> {
  await getNode(env, id);
  const value =
    data.encryption === null ? null : data.encryption === 'none' ? 'none' : data.encryption;
  if (typeof value === 'string' && value !== 'none') {
    if (!KEY_ID.test(value)) throw new AppError(400, '密钥标识不正确。');
    if (!(await env.DB.prepare('SELECT 1 FROM encryption_keys WHERE id=?').bind(value).first()))
      throw new AppError(404, '密钥不存在，请重新设置密码。');
  }
  await env.DB.prepare('UPDATE nodes SET encryption=? WHERE id=?').bind(value, id).run();
  return getNode(env, id);
}
// The keys along a note's path, nearest last: what an AI request on it needs.
export async function nodeKeys(env: Env, id: string) {
  const node = await getNode(env, id);
  return { key_id: node.key_id ?? null, chain: keyChain(await nodePath(env, id)) };
}

// Every node below (and including) the root with the key its content should
// have, worked out downwards from the root's own effective key.
// (Built on use: library.ts and this module import each other.)
const subtree = () => `WITH RECURSIVE sub(id,key_id,depth) AS (
  SELECT n.id,${KEY_SQL('n')},0 FROM nodes n WHERE n.id=?
  UNION ALL SELECT c.id,CASE WHEN c.encryption IS NULL THEN s.key_id ELSE NULLIF(c.encryption,'none') END,s.depth+1
  FROM nodes c JOIN sub s ON c.parent_id=s.id WHERE s.depth<200
)`;
// Every object the subtree refers to. `current` marks the body of a Markdown
// note's current version, whose summary fields follow its key. D1 limits how
// many SELECTs one compound query may join, so each kind is its own query.
const REFS = [
  `'body',v.body_blob_id,v.id=n.current_version_id AND n.kind='markdown',v.id FROM sub s JOIN nodes n ON n.id=s.id JOIN versions v ON v.node_id=s.id JOIN blobs b ON b.id=v.body_blob_id`,
  `'file',a.blob_id,0,NULL FROM sub s JOIN versions v ON v.node_id=s.id JOIN version_assets a ON a.version_id=v.id JOIN blobs b ON b.id=a.blob_id`,
  `'file',n.file_blob_id,0,NULL FROM sub s JOIN nodes n ON n.id=s.id JOIN blobs b ON b.id=n.file_blob_id`,
  `'file',n.icon_blob_id,0,NULL FROM sub s JOIN nodes n ON n.id=s.id JOIN blobs b ON b.id=n.icon_blob_id`,
  `'file',k.cover_blob_id,0,NULL FROM sub s JOIN books k ON k.node_id=s.id JOIN blobs b ON b.id=k.cover_blob_id`,
  `'chat',m.body_blob_id,0,NULL FROM sub s JOIN assistant_messages m ON m.node_id=s.id JOIN blobs b ON b.id=m.body_blob_id`,
  `'file',m.image_blob_id,0,NULL FROM sub s JOIN assistant_messages m ON m.node_id=s.id JOIN blobs b ON b.id=m.image_blob_id`,
  `'file',f.blob_id,0,NULL FROM sub s JOIN assistant_messages m ON m.node_id=s.id JOIN assistant_message_files f ON f.message_id=m.id JOIN blobs b ON b.id=f.blob_id`,
  `'translation',t.body_blob_id,0,NULL FROM sub s JOIN translations t ON t.node_id=s.id JOIN blobs b ON b.id=t.body_blob_id`,
  `'translation',p.body_blob_id,0,NULL FROM sub s JOIN paper_translations p ON p.node_id=s.id JOIN blobs b ON b.id=p.body_blob_id`,
  `'annotation',x.body_blob_id,0,NULL FROM sub s JOIN annotations x ON x.node_id=s.id JOIN blobs b ON b.id=x.body_blob_id`,
];
// The subtree's objects, one entry per object (a Markdown body's current
// version wins), ordered by ID.
async function subtreeObjects(env: Env, root: string, blobId?: string): Promise<PlanObject[]> {
  const results = await env.DB.batch<PlanObject>(
    REFS.map((columns) =>
      env.DB.prepare(
        `${subtree()} SELECT ${columns.replace(
          /^('\w+'),([\w.]+),(.+?),(\S+) FROM/,
          '$1 kind,$2 id,s.id node_id,s.key_id target,$3 current,$4 version_id,b.key_id,b.mime,b.name,b.size FROM',
        )} WHERE b.state='ready'${blobId ? ' AND b.id=?' : ''}`,
      ).bind(root, ...(blobId ? [blobId] : [])),
    ),
  );
  const objects = new Map<string, PlanObject>();
  for (const row of results.flatMap((result) => result.results)) {
    const seen = objects.get(row.id);
    if (!seen || (row.current && !seen.current)) objects.set(row.id, row);
  }
  return [...objects.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}
// What still has to be re-encrypted (or decrypted) so the subtree matches its
// settings. The device does the work: it reads each object, re-seals it and
// replaces it in place; IDs and every reference stay the same.
export async function encryptionPlan(
  env: Env,
  id: string,
  url: URL,
): Promise<{ objects: PlanObject[]; fields: PlanField[] }> {
  await getNode(env, id, true);
  // `sealed=1` lists sealed text instead, for rewriting after a restore.
  const sealedText = url.searchParams.get('sealed') === '1';
  // Pages are ordered by object ID; `after` continues from the previous page.
  const after = url.searchParams.get('after') ? idValue(url.searchParams.get('after')) : '';
  const objects = (await subtreeObjects(env, id))
    .filter((object) =>
      sealedText
        ? object.key_id !== null && object.kind !== 'file'
        : (object.key_id ?? null) !== (object.target ?? null),
    )
    .filter((object) => object.id > after)
    .slice(0, PLAN_LIMIT);
  const [pages, translations] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
      `${subtree()} SELECT p.node_id id,p.summary,p.questions,s.key_id target FROM book_pages p JOIN sub s ON s.id=p.node_id`,
    ).bind(id),
    env.DB.prepare(
      `${subtree()} SELECT t.id,t.node_id,t.excerpt,s.key_id target FROM translations t JOIN sub s ON s.id=t.node_id`,
    ).bind(id),
  ]);
  const fields: PlanField[] = [];
  const mismatched = (value: unknown, target: string | null) =>
    typeof value === 'string' && value !== '' && sealedTextKeyId(value) !== target;
  for (const row of pages.results) {
    const target = (row.target as string | null) ?? null;
    let questions: unknown[] = [];
    try {
      questions = JSON.parse(String(row.questions));
    } catch {
      /* Treated as none. */
    }
    if (mismatched(row.summary, target) || questions.some((value) => mismatched(value, target)))
      fields.push({
        table: 'book_pages',
        id: String(row.id),
        node_id: String(row.id),
        target,
        values: { summary: String(row.summary), questions: String(row.questions) },
      });
  }
  for (const row of translations.results) {
    const target = (row.target as string | null) ?? null;
    if (mismatched(row.excerpt, target))
      fields.push({
        table: 'translations',
        id: String(row.id),
        node_id: String(row.node_id),
        target,
        values: { excerpt: String(row.excerpt) },
      });
  }
  return { objects, fields };
}
async function objectTarget(env: Env, root: string, blobId: string) {
  const [row] = await subtreeObjects(env, root, blobId);
  if (!row) throw new AppError(404, '这个文件不在当前目录中。');
  return { target: row.target ?? null, kind: row.kind, node_id: row.node_id };
}
async function readAll(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  return readLimited(request.body, limit, '文件超过允许大小。');
}
// Replaces an object's content with the same content under another key (or
// none). The blob keeps its ID, so no reference changes.
export async function replaceObject(
  env: Env,
  request: Request,
  root: string,
  blobId: string,
): Promise<{ id: string; key_id: string | null; size: number }> {
  const file = await env.DB.prepare("SELECT * FROM blobs WHERE id=? AND state='ready'")
    .bind(idValue(blobId))
    .first<BlobRow>();
  if (!file) throw new AppError(404, '文件不存在或已被清理。', 'FILE_UNAVAILABLE');
  const { target, kind, node_id } = await objectTarget(env, root, file.id);
  // Encrypted highlights leave the search index; decrypted ones return on the next save.
  return swapObject(
    env,
    request,
    file,
    target,
    kind === 'annotation' && target
      ? [env.DB.prepare("UPDATE annotations SET search_text='' WHERE node_id=?").bind(node_id)]
      : [],
  );
}
// Puts the request's bytes, sealed for `target` (or plain), in place of the object.
export async function swapObject(
  env: Env,
  request: Request,
  file: BlobRow,
  target: string | null,
  also: D1PreparedStatement[] = [],
): Promise<{ id: string; key_id: string | null; size: number }> {
  let bytes = await readAll(request, sealedSize(MAX_FILE_BYTES));
  if (sealedKeyId(bytes) !== target)
    throw new AppError(409, '加密设置已变化，请重新开始。', 'ENCRYPTION_CHANGED');
  if (!target && file.mime === SVG_MIME) {
    try {
      bytes = new TextEncoder().encode(sanitizeSvg(bytes));
    } catch (error) {
      throw new AppError(400, (error as Error).message);
    }
  }
  if (!target && bytes.byteLength > MAX_FILE_BYTES) throw new AppError(413, '文件超过允许大小。');
  const delta = bytes.byteLength - file.size;
  const space = await env.DB.prepare(
    'UPDATE site SET allocated_bytes=allocated_bytes+? WHERE id=1 AND (?<=0 OR allocated_bytes+?<=quota_bytes) RETURNING id',
  )
    .bind(delta, delta, delta)
    .first();
  if (!space) throw new AppError(413, '空间不足，请清理后再加密。', 'QUOTA_EXCEEDED');
  const objectKey = `objects/${file.id}/${crypto.randomUUID()}`;
  try {
    await env.FILES.put(objectKey, bytes, {
      httpMetadata: { contentType: target ? 'application/octet-stream' : file.mime },
    });
    const [changed] = await env.DB.batch([
      env.DB.prepare(
        "UPDATE blobs SET object_key=?,key_id=?,size=? WHERE id=? AND object_key=? AND state='ready' RETURNING id",
      ).bind(objectKey, target, bytes.byteLength, file.id, file.object_key),
      ...also,
    ]);
    if (!changed.results.length) throw new AppError(409, '文件已在别处更新，请重新开始。');
  } catch (error) {
    await env.FILES.delete(objectKey).catch(() => {});
    await env.DB.prepare('UPDATE site SET allocated_bytes=allocated_bytes-? WHERE id=1')
      .bind(delta)
      .run();
    throw error;
  }
  await env.FILES.delete(file.object_key).catch(() => {});
  return { id: file.id, key_id: target, size: bytes.byteLength };
}
// Re-sealed D1 values from the plan, plus summaries of re-sealed notes.
export async function replaceFields(env: Env, root: string, data: Record<string, unknown>) {
  if (!Array.isArray(data.fields) || data.fields.length > 200)
    throw new AppError(400, '字段数量不正确。');
  const targets = new Map(
    (
      await env.DB.prepare(`${subtree()} SELECT id,key_id FROM sub`)
        .bind(root)
        .all<{ id: string; key_id: string | null }>()
    ).results.map((row) => [row.id, row.key_id]),
  );
  const statements: D1PreparedStatement[] = [];
  const text = (value: unknown, target: string | null, max: number) => {
    if (typeof value !== 'string' || value.length > max)
      throw new AppError(400, '字段内容不正确。');
    if (value && sealedTextKeyId(value) !== target)
      throw new AppError(409, '加密设置已变化，请重新开始。', 'ENCRYPTION_CHANGED');
    return value;
  };
  for (const item of data.fields as Record<string, unknown>[]) {
    const nodeId = idValue(item?.node_id);
    if (!targets.has(nodeId)) throw new AppError(404, '这个条目不在当前目录中。');
    const target = targets.get(nodeId) ?? null;
    if (item.table === 'book_pages') {
      const questions = item.questions;
      if (!Array.isArray(questions) || questions.length > 10)
        throw new AppError(400, '字段内容不正确。');
      statements.push(
        env.DB.prepare('UPDATE book_pages SET summary=?,questions=? WHERE node_id=?').bind(
          text(item.summary, target, 4000),
          JSON.stringify(questions.map((value) => text(value, target, 2000))),
          nodeId,
        ),
      );
    } else if (item.table === 'translations')
      statements.push(
        env.DB.prepare('UPDATE translations SET excerpt=? WHERE id=? AND node_id=?').bind(
          text(item.excerpt, target, 2000),
          idValue(item.id),
          nodeId,
        ),
      );
    else if (item.table === 'annotations')
      statements.push(
        env.DB.prepare('UPDATE annotations SET search_text=? WHERE node_id=?').bind(
          target ? '' : textValue(item.search_text ?? '', '批注索引', 600_000, true),
          nodeId,
        ),
      );
    else if (item.table === 'nodes')
      statements.push(
        env.DB.prepare(
          `UPDATE nodes SET metadata_title=?,metadata_status=?,metadata_excerpt=?,metadata_version_id=?
           WHERE id=? AND current_version_id=?`,
        ).bind(
          item.title == null ? null : text(item.title, target, 2000),
          item.status == null ? null : text(item.status, target, 400),
          item.excerpt == null ? null : text(item.excerpt, target, 4000),
          idValue(item.version_id),
          nodeId,
          idValue(item.version_id),
        ),
      );
    else throw new AppError(400, '字段类型不正确。');
  }
  if (statements.length) await env.DB.batch(statements);
  return { ok: true };
}
