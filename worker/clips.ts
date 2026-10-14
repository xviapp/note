import {
  CLIP_BACKDATE,
  CLIP_CHARS,
  CLIP_IMAGE_BYTES,
  CLIP_IMAGE_MIME,
  CLIP_KEEP,
  CLIP_PAGE,
  CLIP_PINNED,
  CLIP_SEALED_CHARS,
  type Clip,
  type ClipList,
} from '../shared/clips';
import { isSealedText, KEY_ID, sealedSize, sealedTextKeyId } from '../shared/encryption';
import { AppError, idValue } from './http';
import { getBlob } from './storage';
import { swapObject } from './encryption';
import type { Env } from './types';

type Row = Omit<Clip, 'pinned' | 'archived' | 'file'> & {
  pinned: number;
  archived: number;
  blob_id: string | null;
  file_name: string | null;
  file_mime: string | null;
  file_size: number | null;
  file_key_id: string | null;
};
const SELECT = `SELECT c.id,c.text,c.key_id,c.source_id,c.pinned,c.archived,c.created_at,c.blob_id,
  b.name file_name,b.mime file_mime,b.size file_size,b.key_id file_key_id,
  (SELECT n.title FROM nodes n WHERE n.id=c.source_id AND n.trash_id IS NULL) source_title
  FROM clips c LEFT JOIN blobs b ON b.id=c.blob_id`;
const clip = ({ blob_id, file_name, file_mime, file_size, file_key_id, ...row }: Row): Clip => ({
  ...row,
  pinned: !!row.pinned,
  archived: !!row.archived,
  file: blob_id
    ? { id: blob_id, name: file_name ?? '', mime: file_mime ?? '', size: file_size ?? 0, key_id: file_key_id }
    : null,
});
const CURSOR = /^(\d{1,15})_([a-zA-Z0-9_-]{1,80})$/;

const KEY = 'SELECT clip_key_id FROM site WHERE id=1';
async function clipKey(env: Env) {
  const row = await env.DB.prepare(KEY).first<{ clip_key_id: string | null }>();
  return row?.clip_key_id ?? null;
}
// What a device needs before sealing a new clip, without the list.
export async function getClipKey(env: Env) {
  return { keyId: await clipKey(env) };
}
// Unpinned clips past CLIP_KEEP, dropped by the periodic cleanup; their
// images are left to the blob sweep that follows.
export const pruneClips = (env: Env) =>
  env.DB.prepare(
    `DELETE FROM clips WHERE pinned=0 AND archived=0 AND id IN (
       SELECT id FROM clips WHERE pinned=0 AND archived=0 ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET ?)`,
  ).bind(CLIP_KEEP);
// Text in the form the setting asks for: sealed with the clip key, or plain.
// A device with an old idea of the setting learns it and seals again. An
// image may come without text.
function checkedText(value: unknown, keyId: string | null, image = false) {
  if (typeof value !== 'string') throw new AppError(400, '请输入内容。');
  if (image && value === '') return value;
  if (keyId ? sealedTextKeyId(value) !== keyId : isSealedText(value))
    throw new AppError(409, '随手记的加密设置已变化，请重试。', 'ENCRYPTION_CHANGED');
  if (keyId) {
    if (value.length > CLIP_SEALED_CHARS) throw new AppError(413, `每条最多 ${CLIP_CHARS} 个字。`);
    return value;
  }
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (!text) throw new AppError(400, '请输入内容。');
  if (text.length > CLIP_CHARS) throw new AppError(413, `每条最多 ${CLIP_CHARS} 个字。`);
  return text;
}

export async function listClips(env: Env, url: URL): Promise<ClipList> {
  const view = url.searchParams.get('view') ?? 'active';
  if (!['active', 'archived', 'all'].includes(view)) throw new AppError(400, '随手记视图不正确。');
  const scope = view === 'all' ? '1=1' : `c.archived=${view === 'archived' ? 1 : 0}`;
  const before = url.searchParams.get('before');
  const cursor = before ? before.match(CURSOR) : null;
  if (before && !cursor) throw new AppError(400, '分页位置不正确。');
  const page = cursor
    ? env.DB.prepare(
        `${SELECT} WHERE ${scope} AND c.pinned=0 AND (c.created_at<? OR (c.created_at=? AND c.id<?))
         ORDER BY c.created_at DESC,c.id DESC LIMIT ?`,
      ).bind(Number(cursor[1]), Number(cursor[1]), cursor[2], CLIP_PAGE + 1)
    : env.DB.prepare(
        `${SELECT} WHERE ${scope} AND c.pinned=0 ORDER BY c.created_at DESC,c.id DESC LIMIT ?`,
      ).bind(CLIP_PAGE + 1);
  // Later pages leave out the pinned clips, which the first one carries.
  const [items, site, pinned] = await env.DB.batch<Row & { clip_key_id: string | null }>([
    page,
    env.DB.prepare(KEY),
    ...(cursor
      ? []
      : [env.DB.prepare(`${SELECT} WHERE ${scope} AND c.pinned=1 ORDER BY c.created_at DESC,c.id DESC`)]),
  ]);
  const rows = items.results.slice(0, CLIP_PAGE);
  const last = rows.at(-1);
  return {
    pinned: pinned?.results.map(clip) ?? [],
    items: rows.map(clip),
    next: items.results.length > CLIP_PAGE && last ? `${last.created_at}_${last.id}` : null,
    keyId: site.results[0]?.clip_key_id ?? null,
  };
}

// The device picks the ID, so a request repeated after a lost response
// returns the clip it saved the first time.
export async function createClip(env: Env, data: Record<string, unknown>): Promise<Clip> {
  const id = idValue(data.id);
  if (data.archived !== undefined && typeof data.archived !== 'boolean')
    throw new AppError(400, '归档状态不正确。');
  const [existing, site] = await env.DB.batch<Row & { clip_key_id: string | null }>([
    env.DB.prepare(`${SELECT} WHERE c.id=?`).bind(id),
    env.DB.prepare(KEY),
  ]);
  if (existing.results[0]) return clip(existing.results[0]);
  const keyId = site.results[0]?.clip_key_id ?? null;
  const blobId = data.blobId == null ? null : idValue(data.blobId);
  const text = checkedText(data.text, keyId, !!blobId);
  if (blobId) {
    const file = await getBlob(env, blobId);
    if (file.key_id !== keyId)
      throw new AppError(409, '随手记的加密设置已变化，请重试。', 'ENCRYPTION_CHANGED');
    if (!CLIP_IMAGE_MIME.test(file.mime) || file.size > sealedSize(CLIP_IMAGE_BYTES))
      throw new AppError(400, `请选择不超过 ${CLIP_IMAGE_BYTES / 1_000_000} MB 的 PNG、JPEG、GIF、WebP 或 AVIF 图片。`);
  }
  const source = data.sourceId == null ? null : idValue(data.sourceId);
  const now = Date.now();
  const created =
    typeof data.createdAt === 'number' && Number.isSafeInteger(data.createdAt)
      ? Math.min(now, Math.max(now - CLIP_BACKDATE, data.createdAt))
      : now;
  // The key is checked again in the write, in case the setting changed meanwhile.
  const [inserted, saved] = await env.DB.batch<Row>([
    env.DB.prepare(
      `INSERT INTO clips(id,text,key_id,source_id,pinned,created_at,blob_id,archived)
       SELECT ?,?,?,?,0,?,?,? WHERE (SELECT clip_key_id FROM site WHERE id=1) IS ?
       ON CONFLICT(id) DO NOTHING RETURNING id`,
    ).bind(id, text, keyId, source, created, blobId, data.archived ? 1 : 0, keyId),
    env.DB.prepare(`${SELECT} WHERE c.id=?`).bind(id),
  ]);
  const row = saved.results[0];
  if (row) return clip(row);
  if (!inserted.results.length)
    throw new AppError(409, '随手记的加密设置已变化，请重试。', 'ENCRYPTION_CHANGED');
  throw new AppError(409, '这条随手记已被删除。');
}

export async function updateClip(
  env: Env,
  id: string,
  data: Record<string, unknown>,
): Promise<Clip> {
  if ('archived' in data) {
    if (typeof data.archived !== 'boolean' || 'pinned' in data)
      throw new AppError(400, '请指定是否归档，置顶需单独操作。');
    const [, current] = await env.DB.batch<Row>([
      env.DB.prepare(`UPDATE clips SET archived=?1,
        pinned=CASE WHEN ?1=1 THEN 0 ELSE pinned END,
        created_at=CASE WHEN archived=1 AND ?1=0 THEN ?2 ELSE created_at END
        WHERE id=?3`).bind(data.archived ? 1 : 0, Date.now(), id),
      env.DB.prepare(`${SELECT} WHERE c.id=?`).bind(id),
    ]);
    if (!current.results[0]) throw new AppError(404, '这条随手记不存在或已删除。');
    return clip(current.results[0]);
  }
  if (typeof data.pinned !== 'boolean') throw new AppError(400, '请指定是否置顶。');
  // Pinning stops at CLIP_PINNED. An unpinned clip counts as created now, so
  // it is not dropped at once as the oldest.
  const [updated, current] = await env.DB.batch<Row>([
    env.DB.prepare(
      `UPDATE clips SET pinned=?1,created_at=CASE WHEN pinned=1 AND ?1=0 THEN ?2 ELSE created_at END
       WHERE id=?3 AND archived=0 AND (?1=0 OR pinned=1 OR (SELECT COUNT(*) FROM clips WHERE pinned=1 AND archived=0)<?4)
       RETURNING id`,
    ).bind(data.pinned ? 1 : 0, Date.now(), id, CLIP_PINNED),
    env.DB.prepare(`${SELECT} WHERE c.id=?`).bind(id),
  ]);
  const row = current.results[0];
  if (!row) throw new AppError(404, '这条随手记不存在或已删除。');
  if (row.archived) throw new AppError(400, '请先恢复这条随手记，再置顶。');
  if (!updated.results.length) throw new AppError(400, `最多置顶 ${CLIP_PINNED} 条。`);
  return clip(row);
}

export async function deleteClip(env: Env, id: string) {
  await env.DB.prepare('DELETE FROM clips WHERE id=?').bind(id).run();
  return { ok: true };
}

// Changes the clip key. The device re-seals existing clips for the new
// setting and sends them in batches with the same `keyId`; each must match.
// Images are replaced in place (replaceClipImage). `remaining` counts clips
// whose text or image is not yet in the new form.
export async function setClipEncryption(env: Env, data: Record<string, unknown>) {
  const keyId = data.keyId === null ? null : typeof data.keyId === 'string' ? data.keyId : '';
  if (keyId !== null && !KEY_ID.test(keyId)) throw new AppError(400, '密钥标识不正确。');
  if (keyId && !(await env.DB.prepare('SELECT 1 FROM encryption_keys WHERE id=?').bind(keyId).first()))
    throw new AppError(404, '密钥不存在，请重新设置密码。');
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length > 100) throw new AppError(400, '每次最多处理 100 条。');
  const updates = items.map((item) => {
    const value = item as Record<string, unknown>;
    const text = checkedText(value.text, keyId, true);
    // Only an image clip has no text.
    return env.DB.prepare(
      "UPDATE clips SET text=?,key_id=? WHERE id=? AND (?!='' OR blob_id IS NOT NULL)",
    ).bind(text, keyId, idValue(value.id), text);
  });
  await env.DB.batch([
    env.DB.prepare('UPDATE site SET clip_key_id=? WHERE id=1').bind(keyId),
    ...updates,
  ]);
  const remaining = await env.DB.prepare(
    `SELECT COUNT(*) count FROM clips c LEFT JOIN blobs b ON b.id=c.blob_id
     WHERE c.key_id IS NOT ? OR (c.blob_id IS NOT NULL AND b.key_id IS NOT ?)`,
  )
    .bind(keyId, keyId)
    .first<{ count: number }>();
  return { keyId, remaining: remaining!.count };
}

// A clip's image, re-sealed on the device for the current clip key.
export async function replaceClipImage(env: Env, request: Request, blobId: string) {
  const file = await getBlob(env, blobId);
  if (!(await env.DB.prepare('SELECT 1 FROM clips WHERE blob_id=?').bind(file.id).first()))
    throw new AppError(404, '这张图片不属于随手记。');
  return swapObject(env, request, file, await clipKey(env));
}
