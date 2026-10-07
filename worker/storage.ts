import { GLOBAL_ASSISTANT_ID } from '../shared/assistant';
import type { BlobRow, Env } from './types';
import { AppError, idValue } from './http';
import type { StorageInfo, StorageUsage } from '../shared/types';
import { sanitizeSvg, SVG_LIMIT, SVG_MIME } from '../shared/svg';
import { CHAT_BODY_BYTE_LIMIT } from '../shared/chat-files';
import {
  KEY_ID,
  openBytes,
  SEALED_HEADER,
  sealBytes,
  sealedKeyId,
  sealedSize,
  toBase64Url,
} from '../shared/encryption';
import { keyFor } from './encryption';

export const MAX_FILE_BYTES = 50_000_000;
export const MAX_TEXT_BYTES = 1_048_576;
// Types a stored object may have (as in backups).
export const STORED_MIME =
  /^(text\/(plain|html)(; charset=utf-8)?|application\/(json(; charset=utf-8)?|pdf|octet-stream)|image\/(png|jpeg|gif|webp|avif|svg\+xml))$/;
const TEXT_MIME = /^(text\/(plain|html)|application\/json); charset=utf-8$/;
const DAY = 86400_000;
export const LIBRARY_UNREFERENCED = `NOT EXISTS(SELECT 1 FROM versions v WHERE v.body_blob_id=blobs.id)
 AND NOT EXISTS(SELECT 1 FROM version_assets a WHERE a.blob_id=blobs.id)
 AND NOT EXISTS(SELECT 1 FROM nodes n WHERE n.file_blob_id=blobs.id)
 AND NOT EXISTS(SELECT 1 FROM nodes n WHERE n.icon_blob_id=blobs.id)
 AND NOT EXISTS(SELECT 1 FROM books b WHERE b.cover_blob_id=blobs.id)
 AND NOT EXISTS(SELECT 1 FROM assistant_messages m WHERE m.body_blob_id=blobs.id OR m.image_blob_id=blobs.id)
 AND NOT EXISTS(SELECT 1 FROM assistant_message_files a WHERE a.blob_id=blobs.id)
 AND NOT EXISTS(SELECT 1 FROM translations t WHERE t.body_blob_id=blobs.id)
 AND NOT EXISTS(SELECT 1 FROM paper_translations p WHERE p.body_blob_id=blobs.id)
 AND NOT EXISTS(SELECT 1 FROM annotations n WHERE n.body_blob_id=blobs.id)
 AND NOT EXISTS(SELECT 1 FROM clips c WHERE c.blob_id=blobs.id)`;
export const UNREFERENCED = `${LIBRARY_UNREFERENCED}
 AND NOT EXISTS(SELECT 1 FROM backup_files f WHERE f.blob_id=blobs.id)`;

export async function getBlob(env: Env, id: string): Promise<BlobRow> {
  const file = await env.DB.prepare("SELECT * FROM blobs WHERE id=? AND state='ready'")
    .bind(idValue(id))
    .first<BlobRow>();
  if (!file) throw new AppError(404, '文件不存在或已被清理。', 'FILE_UNAVAILABLE');
  return file;
}
async function reserve(
  env: Env,
  name: string,
  mime: string,
  size: number,
  keyId: string | null = null,
): Promise<BlobRow> {
  const id = crypto.randomUUID(),
    now = Date.now();
  const row: BlobRow = {
    id,
    object_key: `objects/${id}`,
    name,
    mime,
    size,
    state: 'pending',
    draft_until: now + DAY,
    created_at: now,
    key_id: keyId,
  };
  await env.DB.prepare(
    "INSERT INTO blobs(id,object_key,name,mime,size,state,draft_until,created_at,key_id) VALUES(?,?,?,?,?,'pending',?,?,?)",
  )
    .bind(id, row.object_key, name, mime, size, row.draft_until, now, keyId)
    .run();
  return row;
}
async function finish(env: Env, file: BlobRow): Promise<BlobRow> {
  const changed = await env.DB.prepare(
    "UPDATE blobs SET state='ready' WHERE id=? AND state='pending' RETURNING id",
  )
    .bind(file.id)
    .first();
  if (!changed) throw new AppError(409, '上传预留已过期，请重新上传。');
  return { ...file, state: 'ready' };
}
async function abandon(env: Env, file: BlobRow): Promise<void> {
  try {
    await env.FILES.delete(file.object_key);
    await env.DB.prepare('DELETE FROM blobs WHERE id=?').bind(file.id).run();
  } catch {
    await env.DB.prepare('UPDATE blobs SET draft_until=? WHERE id=?')
      .bind(Date.now(), file.id)
      .run();
  }
}
// `keyId` seals the content with that key, which the request must carry.
export async function storeText(
  env: Env,
  content: string,
  keyId: string | null = null,
): Promise<BlobRow> {
  return storeBody(env, content, 'content.txt', 'text/plain; charset=utf-8', MAX_TEXT_BYTES, keyId);
}
export async function storeChatBody(
  env: Env,
  content: string,
  keyId: string | null = null,
): Promise<BlobRow> {
  return storeBody(
    env,
    content,
    'conversation.json',
    'application/json; charset=utf-8',
    CHAT_BODY_BYTE_LIMIT,
    keyId,
  );
}
export async function storePaper(env: Env, content: string): Promise<BlobRow> {
  return storeBody(env, content, 'paper.html', 'text/html; charset=utf-8', 8 * 1_048_576);
}
export async function storeSvg(env: Env, bytes: Uint8Array, name: string): Promise<BlobRow> {
  let content: string;
  try {
    content = sanitizeSvg(bytes);
  } catch (error) {
    throw new AppError(400, (error as Error).message);
  }
  return storeBody(env, content, name, SVG_MIME, SVG_LIMIT);
}
async function storeBody(
  env: Env,
  content: string,
  name: string,
  mime: string,
  limit: number,
  keyId: string | null = null,
): Promise<BlobRow> {
  const plain = new TextEncoder().encode(content);
  if (plain.byteLength > limit)
    throw new AppError(
      413,
      name === 'paper.html'
        ? '论文 HTML 超过 8 MiB，无法导入。'
        : name === 'conversation.json'
          ? '本次对话数据超过 16 MiB，请减少附件或缩小 PDF 页码范围。'
          : '单篇正文最多 1 MiB，请拆分为多个子笔记。',
    );
  return storeBytes(env, plain, name, mime, keyId);
}
// Stores bytes as one object, sealed when a key is given.
export async function storeBytes(
  env: Env,
  plain: Uint8Array<ArrayBuffer>,
  name: string,
  mime: string,
  keyId: string | null = null,
): Promise<BlobRow> {
  const bytes = keyId ? await sealBytes(keyFor(env, keyId), keyId, plain) : plain;
  const file = await reserve(env, name, mime, bytes.byteLength, keyId);
  try {
    await env.FILES.put(file.object_key, bytes, {
      httpMetadata: { contentType: keyId ? 'application/octet-stream' : file.mime },
    });
    return await finish(env, file);
  } catch (error) {
    await abandon(env, file);
    throw error;
  }
}
function detectMime(bytes: Uint8Array): string {
  const text = new TextDecoder('latin1').decode(bytes.slice(0, 16));
  if (text.startsWith('%PDF-')) return 'application/pdf';
  if (bytes[0] === 137 && text.slice(1, 4) === 'PNG') return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (text.startsWith('GIF87a') || text.startsWith('GIF89a')) return 'image/gif';
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return 'image/webp';
  if (text.slice(4, 8) === 'ftyp' && /avif|avis/.test(text.slice(8, 16))) return 'image/avif';
  return 'application/octet-stream';
}
export async function uploadFile(env: Env, request: Request): Promise<BlobRow> {
  const url = new URL(request.url),
    name = url.searchParams.get('name')?.trim(),
    size = Number(url.searchParams.get('size'));
  // A device-sealed upload names its key and the type of the plain file.
  const keyId = url.searchParams.get('key') || null,
    declaredMime = url.searchParams.get('mime') || '';
  if (
    !name ||
    name.length > 200 ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > (keyId ? sealedSize(MAX_FILE_BYTES) : MAX_FILE_BYTES) ||
    !request.body
  )
    throw new AppError(400, '请选择不超过 50 MB 的文件。');
  if (keyId) {
    if (!KEY_ID.test(keyId) || !STORED_MIME.test(declaredMime))
      throw new AppError(400, '加密文件信息不正确。');
    if (!(await env.DB.prepare('SELECT 1 FROM encryption_keys WHERE id=?').bind(keyId).first()))
      throw new AppError(404, '密钥不存在，请重新设置密码。');
  }
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) !== size)
    throw new AppError(400, '上传未完成或文件大小发生变化，请重新选择文件。');
  const reader = request.body.getReader(),
    prefix: Uint8Array[] = [];
  let prefixSize = 0;
  const want = keyId ? SEALED_HEADER : 16;
  while (prefixSize < want) {
    const chunk = await reader.read();
    if (chunk.done) break;
    prefix.push(chunk.value);
    prefixSize += chunk.value.length;
  }
  if (!prefixSize) throw new AppError(400, '文件内容为空。');
  const signature = new Uint8Array(Math.min(prefixSize, want));
  let offset = 0;
  for (const chunk of prefix) {
    const take = Math.min(signature.length - offset, chunk.length);
    signature.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset === signature.length) break;
  }
  if (keyId && new TextDecoder('latin1').decode(signature.subarray(0, 40)) !== `XVE1${keyId}`) {
    await reader.cancel().catch(() => {});
    throw new AppError(400, '加密文件格式不正确，请重试。');
  }
  if (
    !keyId &&
    (/\.svg$/i.test(name) ||
      request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === SVG_MIME ||
      /^\s*<svg[\s>]/i.test(new TextDecoder().decode(signature)))
  ) {
    let received = prefixSize;
    try {
      if (size > SVG_LIMIT) throw new AppError(413, 'SVG 图片最多 10 MiB。');
      if (received > size) throw new AppError(400, 'SVG 上传大小与声明不符。');
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        received += part.value.byteLength;
        if (received > size) throw new AppError(400, 'SVG 上传大小与声明不符。');
        prefix.push(part.value);
      }
      if (received !== size) throw new AppError(400, 'SVG 上传未完成，请重试。');
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = new Uint8Array(received);
    let position = 0;
    for (const chunk of prefix) {
      bytes.set(chunk, position);
      position += chunk.byteLength;
    }
    return storeSvg(env, bytes, name);
  }
  let mime = keyId ? declaredMime : detectMime(signature);
  // Text re-uploaded in plain keeps its type (see the encryption plan).
  if (mime === 'application/octet-stream' && TEXT_MIME.test(declaredMime)) mime = declaredMime;
  let file: BlobRow;
  try {
    file = await reserve(env, name, mime, size, keyId);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const stream = new FixedLengthStream(size);
  const writer = stream.writable.getWriter();
  const pump = (async () => {
    try {
      for (const chunk of prefix) await writer.write(chunk);
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        await writer.write(chunk.value);
      }
      await writer.close();
    } catch (error) {
      await writer.abort(error).catch(() => {});
      await reader.cancel().catch(() => {});
      throw error;
    }
  })();
  const put = env.FILES.put(file.object_key, stream.readable, {
    httpMetadata: { contentType: keyId ? 'application/octet-stream' : mime },
  });
  try {
    await Promise.all([pump, put]);
    return await finish(env, file);
  } catch (error) {
    await reader.cancel().catch(() => {});
    await stream.readable.cancel(error).catch(() => {});
    await writer.abort(error).catch(() => {});
    await Promise.allSettled([pump, put]);
    await abandon(env, file);
    throw new AppError(400, '上传未完成或文件大小发生变化，请重新选择文件。');
  }
}
// The plain bytes of an object; a sealed one needs its key in the request.
export async function readBytes(env: Env, file: BlobRow): Promise<Uint8Array<ArrayBuffer>> {
  const key = file.key_id ? keyFor(env, file.key_id) : null;
  const object = await env.FILES.get(file.object_key);
  if (!object) throw new AppError(503, '内容暂时无法读取，请稍后重试。');
  const bytes = new Uint8Array(await object.arrayBuffer());
  return key ? openBytes(key, bytes) : bytes;
}
export async function readText(env: Env, blobId: string): Promise<string> {
  return new TextDecoder().decode(await readBytes(env, await getBlob(env, blobId)));
}
// A body for the device: plain text, or the sealed object when the request
// does not carry its key (the device decrypts it).
export async function readBody(
  env: Env,
  blobId: string,
): Promise<{ content: string; sealed?: string }> {
  const file = await getBlob(env, blobId);
  if (!file.key_id || env.KEYS?.has(file.key_id))
    return { content: new TextDecoder().decode(await readBytes(env, file)) };
  const object = await env.FILES.get(file.object_key);
  if (!object) throw new AppError(503, '正文暂时无法读取，请稍后重试。');
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (sealedKeyId(bytes) !== file.key_id) throw new AppError(503, '正文已损坏，无法解密。');
  return { content: '', sealed: toBase64Url(bytes) };
}
export async function serveFile(env: Env, request: Request, id: string): Promise<Response> {
  const file = await getBlob(env, id),
    range = request.headers.get('range');
  let partial: { offset: number; length: number } | undefined;
  if (range && request.method !== 'HEAD') {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (!match[1] && !match[2])) throw new AppError(416, '文件读取范围不正确。');
    const start = match[1] ? Number(match[1]) : Math.max(0, file.size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(Number(match[2]), file.size - 1) : file.size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start > end ||
      start >= file.size
    )
      return new Response(null, {
        status: 416,
        headers: { 'content-range': `bytes */${file.size}`, 'cache-control': 'private, no-store' },
      });
    partial = { offset: start, length: end - start + 1 };
  }
  const object =
    request.method === 'HEAD'
      ? await env.FILES.head(file.object_key)
      : await env.FILES.get(file.object_key, partial ? { range: partial } : undefined);
  if (!object) throw new AppError(404, '文件不存在。');
  const inline =
    !file.key_id &&
    (file.mime === 'application/pdf' ||
      /^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/.test(file.mime));
  const download = new URL(request.url).searchParams.has('download');
  const headers = new Headers({
    // A sealed object is only meaningful to a device holding its key.
    'content-type': file.key_id ? 'application/octet-stream' : file.mime,
    ...(file.key_id ? { 'x-note-key': file.key_id, 'x-note-type': file.mime } : {}),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'content-disposition': `${inline && !download ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'accept-ranges': 'bytes',
    etag: object.httpEtag,
    'content-security-policy':
      file.mime === SVG_MIME
        ? "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox"
        : "default-src 'none'; sandbox",
  });
  if (partial) {
    headers.set(
      'content-range',
      `bytes ${partial.offset}-${partial.offset + partial.length - 1}/${file.size}`,
    );
    headers.set('content-length', String(partial.length));
  } else headers.set('content-length', String(file.size));
  return new Response(request.method === 'HEAD' ? null : (object as R2ObjectBody).body, {
    status: partial ? 206 : 200,
    headers,
  });
}
export async function discardFile(env: Env, id: string): Promise<boolean> {
  const file = await env.DB.prepare(
    `UPDATE blobs SET state='deleting' WHERE id=? AND state IN ('ready','deleting') AND ${UNREFERENCED} RETURNING *`,
  )
    .bind(id)
    .first<BlobRow>();
  if (!file) return false;
  await env.FILES.delete(file.object_key);
  await env.DB.prepare("DELETE FROM blobs WHERE id=? AND state='deleting'").bind(id).run();
  return true;
}
export async function storageUsage(env: Env): Promise<StorageUsage> {
  const site = await env.DB.prepare('SELECT quota_bytes,allocated_bytes FROM site WHERE id=1').first<{
    quota_bytes: number;
    allocated_bytes: number;
  }>();
  return { quotaBytes: site!.quota_bytes, allocatedBytes: site!.allocated_bytes };
}
// The breakdown scans every blob against each table that can reference it, so it
// is read only by the storage settings page, never after each change.
export async function storageInfo(env: Env): Promise<StorageInfo> {
  const siteQuery = env.DB.prepare('SELECT quota_bytes,allocated_bytes FROM site WHERE id=1');
  const aiLive = `(EXISTS(SELECT 1 FROM assistant_messages m LEFT JOIN nodes n ON n.id=m.node_id WHERE (m.node_id='${GLOBAL_ASSISTANT_ID}' OR (n.id IS NOT NULL AND n.trash_id IS NULL)) AND (m.body_blob_id=b.id OR m.image_blob_id=b.id)) OR EXISTS(SELECT 1 FROM assistant_message_files a JOIN assistant_messages m ON m.id=a.message_id LEFT JOIN nodes n ON n.id=m.node_id WHERE (m.node_id='${GLOBAL_ASSISTANT_ID}' OR (n.id IS NOT NULL AND n.trash_id IS NULL)) AND a.blob_id=b.id) OR EXISTS(SELECT 1 FROM translations t JOIN nodes n ON n.id=t.node_id WHERE n.trash_id IS NULL AND t.body_blob_id=b.id) OR EXISTS(SELECT 1 FROM paper_translations p JOIN nodes n ON n.id=p.node_id WHERE n.trash_id IS NULL AND p.body_blob_id=b.id) OR EXISTS(SELECT 1 FROM annotations x JOIN nodes n ON n.id=x.node_id WHERE n.trash_id IS NULL AND x.body_blob_id=b.id) OR EXISTS(SELECT 1 FROM books k JOIN nodes n ON n.id=k.node_id WHERE n.trash_id IS NULL AND k.cover_blob_id=b.id) OR EXISTS(SELECT 1 FROM clips c WHERE c.blob_id=b.id))`;
  const aiReferenced = `(EXISTS(SELECT 1 FROM assistant_messages m WHERE m.body_blob_id=b.id OR m.image_blob_id=b.id) OR EXISTS(SELECT 1 FROM assistant_message_files a WHERE a.blob_id=b.id) OR EXISTS(SELECT 1 FROM translations t WHERE t.body_blob_id=b.id) OR EXISTS(SELECT 1 FROM paper_translations p WHERE p.body_blob_id=b.id) OR EXISTS(SELECT 1 FROM annotations x WHERE x.body_blob_id=b.id) OR EXISTS(SELECT 1 FROM books k WHERE k.cover_blob_id=b.id) OR EXISTS(SELECT 1 FROM clips c WHERE c.blob_id=b.id))`;
  const sumsQuery = env.DB.prepare(
    `SELECT
    COALESCE(SUM(CASE WHEN state='pending' THEN size ELSE 0 END),0) reserved,
    COALESCE(SUM(CASE WHEN state!='pending' AND (
      EXISTS(SELECT 1 FROM nodes n WHERE n.trash_id IS NULL AND (n.file_blob_id=b.id OR n.icon_blob_id=b.id)) OR
      EXISTS(SELECT 1 FROM nodes n JOIN versions v ON v.id=n.current_version_id WHERE n.trash_id IS NULL AND v.body_blob_id=b.id) OR
      EXISTS(SELECT 1 FROM nodes n JOIN version_assets a ON a.version_id=n.current_version_id WHERE n.trash_id IS NULL AND a.blob_id=b.id) OR ${aiLive}
    ) THEN size ELSE 0 END),0) current,
    COALESCE(SUM(CASE WHEN state!='pending' AND (EXISTS(SELECT 1 FROM versions v JOIN nodes n ON n.id=v.node_id WHERE n.trash_id IS NULL AND v.body_blob_id=b.id) OR EXISTS(SELECT 1 FROM version_assets a JOIN versions v ON v.id=a.version_id JOIN nodes n ON n.id=v.node_id WHERE n.trash_id IS NULL AND a.blob_id=b.id) OR EXISTS(SELECT 1 FROM nodes n WHERE n.trash_id IS NULL AND (n.file_blob_id=b.id OR n.icon_blob_id=b.id)) OR ${aiLive}) THEN size ELSE 0 END),0) live,
    COALESCE(SUM(CASE WHEN state!='pending' AND (EXISTS(SELECT 1 FROM versions v WHERE v.body_blob_id=b.id) OR EXISTS(SELECT 1 FROM version_assets a WHERE a.blob_id=b.id) OR EXISTS(SELECT 1 FROM nodes n WHERE n.file_blob_id=b.id OR n.icon_blob_id=b.id) OR ${aiReferenced}) THEN size ELSE 0 END),0) referenced
    FROM blobs b`,
  );
  // Read both views in one D1 transaction so an upload or a cleanup between
  // queries cannot make the displayed breakdown negative or inconsistent.
  const [settings, totals] = await env.DB.batch<Record<string, number>>([siteQuery, sumsQuery]);
  const site = settings.results[0],
    sums = totals.results[0];
  return {
    quotaBytes: site!.quota_bytes,
    allocatedBytes: site!.allocated_bytes,
    reservedBytes: sums!.reserved,
    currentBytes: sums!.current,
    historyBytes: sums!.live - sums!.current,
    trashBytes: sums!.referenced - sums!.live,
    orphanBytes: site!.allocated_bytes - sums!.reserved - sums!.referenced,
  };
}
