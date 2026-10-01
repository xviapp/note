import type { BlobRow, Env } from './types';
import { AppError, idValue } from './http';
import type { StorageInfo } from '../shared/types';
import { sanitizeSvg, SVG_LIMIT, SVG_MIME } from '../shared/svg';

export const MAX_FILE_BYTES = 50_000_000;
export const MAX_TEXT_BYTES = 1_048_576;
const DAY = 86400_000;
export const UNREFERENCED = `NOT EXISTS(SELECT 1 FROM versions v WHERE v.body_blob_id=blobs.id)
 AND NOT EXISTS(SELECT 1 FROM version_assets a WHERE a.blob_id=blobs.id)
 AND NOT EXISTS(SELECT 1 FROM nodes n WHERE n.file_blob_id=blobs.id)
 AND NOT EXISTS(SELECT 1 FROM assistant_messages m WHERE m.body_blob_id=blobs.id OR m.image_blob_id=blobs.id)
 AND NOT EXISTS(SELECT 1 FROM assistant_message_files a WHERE a.blob_id=blobs.id)
 AND NOT EXISTS(SELECT 1 FROM translations t WHERE t.body_blob_id=blobs.id)`;

export async function getBlob(env: Env, id: string): Promise<BlobRow> {
  const file = await env.DB.prepare("SELECT * FROM blobs WHERE id=? AND state='ready'")
    .bind(idValue(id))
    .first<BlobRow>();
  if (!file) throw new AppError(404, '文件不存在或已被清理。', 'FILE_UNAVAILABLE');
  return file;
}
async function reserve(env: Env, name: string, mime: string, size: number): Promise<BlobRow> {
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
  };
  await env.DB.prepare(
    "INSERT INTO blobs(id,object_key,name,mime,size,state,draft_until,created_at) VALUES(?,?,?,?,?,'pending',?,?)",
  )
    .bind(id, row.object_key, name, mime, size, row.draft_until, now)
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
export async function storeText(env: Env, content: string): Promise<BlobRow> {
  return storeBody(env, content, 'content.txt', 'text/plain; charset=utf-8', MAX_TEXT_BYTES);
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
): Promise<BlobRow> {
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > limit)
    throw new AppError(
      413,
      name === 'paper.html'
        ? '论文 HTML 超过 8 MiB，无法导入。'
        : '单篇正文最多 1 MiB，请拆分为多个子笔记。',
    );
  const file = await reserve(env, name, mime, bytes.byteLength);
  try {
    await env.FILES.put(file.object_key, bytes, { httpMetadata: { contentType: file.mime } });
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
  if (
    !name ||
    name.length > 200 ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > MAX_FILE_BYTES ||
    !request.body
  )
    throw new AppError(400, '请选择不超过 50 MB 的文件。');
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) !== size)
    throw new AppError(400, '上传未完成或文件大小发生变化，请重新选择文件。');
  const reader = request.body.getReader(),
    prefix: Uint8Array[] = [];
  let prefixSize = 0;
  while (prefixSize < 16) {
    const chunk = await reader.read();
    if (chunk.done) break;
    prefix.push(chunk.value);
    prefixSize += chunk.value.length;
  }
  if (!prefixSize) throw new AppError(400, '文件内容为空。');
  const signature = new Uint8Array(Math.min(prefixSize, 16));
  let offset = 0;
  for (const chunk of prefix) {
    const take = Math.min(signature.length - offset, chunk.length);
    signature.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset === signature.length) break;
  }
  if (
    /\.svg$/i.test(name) ||
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === SVG_MIME ||
    /^\s*<svg[\s>]/i.test(new TextDecoder().decode(signature))
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
  const mime = detectMime(signature);
  let file: BlobRow;
  try {
    file = await reserve(env, name, mime, size);
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
    httpMetadata: { contentType: mime },
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
export async function readText(env: Env, blobId: string): Promise<string> {
  const file = await getBlob(env, blobId);
  const object = await env.FILES.get(file.object_key);
  if (!object) throw new AppError(503, '正文暂时无法读取，请稍后重试。');
  return object.text();
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
    file.mime === 'application/pdf' || /^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/.test(file.mime);
  const download = new URL(request.url).searchParams.has('download');
  const headers = new Headers({
    'content-type': file.mime,
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
export async function storageInfo(env: Env): Promise<StorageInfo> {
  const siteQuery = env.DB.prepare('SELECT quota_bytes,allocated_bytes FROM site WHERE id=1');
  const aiLive = `(EXISTS(SELECT 1 FROM assistant_messages m JOIN nodes n ON n.id=m.node_id WHERE n.trash_id IS NULL AND (m.body_blob_id=b.id OR m.image_blob_id=b.id)) OR EXISTS(SELECT 1 FROM assistant_message_files a JOIN assistant_messages m ON m.id=a.message_id JOIN nodes n ON n.id=m.node_id WHERE n.trash_id IS NULL AND a.blob_id=b.id) OR EXISTS(SELECT 1 FROM translations t JOIN nodes n ON n.id=t.node_id WHERE n.trash_id IS NULL AND t.body_blob_id=b.id))`;
  const aiReferenced = `(EXISTS(SELECT 1 FROM assistant_messages m WHERE m.body_blob_id=b.id OR m.image_blob_id=b.id) OR EXISTS(SELECT 1 FROM assistant_message_files a WHERE a.blob_id=b.id) OR EXISTS(SELECT 1 FROM translations t WHERE t.body_blob_id=b.id))`;
  const sumsQuery = env.DB.prepare(
    `SELECT
    COALESCE(SUM(CASE WHEN state='pending' THEN size ELSE 0 END),0) reserved,
    COALESCE(SUM(CASE WHEN state!='pending' AND (
      EXISTS(SELECT 1 FROM nodes n WHERE n.trash_id IS NULL AND n.file_blob_id=b.id) OR
      EXISTS(SELECT 1 FROM nodes n JOIN versions v ON v.id=n.current_version_id WHERE n.trash_id IS NULL AND v.body_blob_id=b.id) OR
      EXISTS(SELECT 1 FROM nodes n JOIN version_assets a ON a.version_id=n.current_version_id WHERE n.trash_id IS NULL AND a.blob_id=b.id) OR ${aiLive}
    ) THEN size ELSE 0 END),0) current,
    COALESCE(SUM(CASE WHEN state!='pending' AND (EXISTS(SELECT 1 FROM versions v JOIN nodes n ON n.id=v.node_id WHERE n.trash_id IS NULL AND v.body_blob_id=b.id) OR EXISTS(SELECT 1 FROM version_assets a JOIN versions v ON v.id=a.version_id JOIN nodes n ON n.id=v.node_id WHERE n.trash_id IS NULL AND a.blob_id=b.id) OR EXISTS(SELECT 1 FROM nodes n WHERE n.trash_id IS NULL AND n.file_blob_id=b.id) OR ${aiLive}) THEN size ELSE 0 END),0) live,
    COALESCE(SUM(CASE WHEN state!='pending' AND (EXISTS(SELECT 1 FROM versions v WHERE v.body_blob_id=b.id) OR EXISTS(SELECT 1 FROM version_assets a WHERE a.blob_id=b.id) OR EXISTS(SELECT 1 FROM nodes n WHERE n.file_blob_id=b.id) OR ${aiReferenced}) THEN size ELSE 0 END),0) referenced
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
