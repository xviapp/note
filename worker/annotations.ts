import {
  ANNOTATION_COUNT,
  ANNOTATION_NOTE_CHARS,
  ANNOTATION_QUOTE_CHARS,
  annotationSearchText,
  isAnnotationColor,
  type Annotation,
  type AnnotationList,
} from '../shared/annotations';
import { AppError } from './http';
import { getNode } from './library';
import { discardFile, readText, storeText } from './storage';
import { sourceLocation } from './translation';
import type { Env } from './types';

interface Row {
  body_blob_id: string;
  updated_at: number;
}
const ID = /^[a-zA-Z0-9_-]{1,80}$/;

async function annotatedNode(env: Env, id: string) {
  const node = await getNode(env, id);
  if (node.kind === 'folder') throw new AppError(400, '请打开一个文件使用批注。');
  return node;
}
async function stored(env: Env, nodeId: string) {
  const row = await env.DB.prepare(
    'SELECT body_blob_id,updated_at FROM annotations WHERE node_id=?',
  )
    .bind(nodeId)
    .first<Row>();
  if (!row) return { row: null, annotations: [] as Annotation[] };
  const data = JSON.parse(await readText(env, row.body_blob_id)) as { annotations?: Annotation[] };
  return { row, annotations: data.annotations ?? [] };
}
// Writes a changed list. Another tab may save meanwhile, so the change is
// applied to the latest list and the row only moves from the blob it read.
async function save(
  env: Env,
  nodeId: string,
  change: (annotations: Annotation[]) => Annotation[],
): Promise<AnnotationList> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const latest = await stored(env, nodeId);
    const annotations = change(latest.annotations);
    const body = JSON.stringify({ annotations });
    const space = await env.DB.prepare(
      'SELECT quota_bytes-allocated_bytes available FROM site WHERE id=1',
    ).first<{ available: number }>();
    if (!space || space.available < new TextEncoder().encode(body).length)
      throw new AppError(413, '空间不足，请清理后再保存批注。', 'QUOTA_EXCEEDED');
    const blob = await storeText(env, body);
    const now = Date.now();
    const saved = latest.row
      ? await env.DB.prepare(
          `UPDATE annotations SET body_blob_id=?,updated_at=?,search_text=? WHERE node_id=? AND body_blob_id=?
           AND EXISTS(SELECT 1 FROM nodes WHERE id=? AND trash_id IS NULL) RETURNING node_id`,
        )
          .bind(
            blob.id,
            now,
            annotationSearchText(annotations),
            nodeId,
            latest.row.body_blob_id,
            nodeId,
          )
          .first()
      : await env.DB.prepare(
          `INSERT INTO annotations(node_id,body_blob_id,updated_at,search_text)
           SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM nodes WHERE id=? AND trash_id IS NULL)
           ON CONFLICT DO NOTHING RETURNING node_id`,
        )
          .bind(nodeId, blob.id, now, annotationSearchText(annotations), nodeId)
          .first();
    if (saved) {
      if (latest.row) await discardFile(env, latest.row.body_blob_id).catch(() => {});
      return { annotations, updatedAt: now };
    }
    await discardFile(env, blob.id).catch(() => {});
    await annotatedNode(env, nodeId);
  }
  throw new AppError(409, '批注正在别处保存，请稍后重试。');
}

export async function listAnnotations(env: Env, nodeId: string): Promise<AnnotationList> {
  await annotatedNode(env, nodeId);
  const { row, annotations } = await stored(env, nodeId);
  return { annotations, updatedAt: row?.updated_at ?? null };
}

// Adds or replaces one annotation. The client picks the id, so a repeated
// request after a lost response saves the same annotation again.
export async function putAnnotation(
  env: Env,
  nodeId: string,
  id: string,
  data: Record<string, unknown>,
): Promise<AnnotationList> {
  await annotatedNode(env, nodeId);
  if (!ID.test(id)) throw new AppError(400, '批注标识不正确。');
  const quote = typeof data.quote === 'string' ? data.quote.trim() : '';
  if (!quote || quote.length > ANNOTATION_QUOTE_CHARS)
    throw new AppError(400, `批注的原文需在 1–${ANNOTATION_QUOTE_CHARS} 个字符之间。`);
  if (typeof data.note !== 'string' || data.note.length > ANNOTATION_NOTE_CHARS)
    throw new AppError(400, `批注最多 ${ANNOTATION_NOTE_CHARS} 个字符。`);
  if (data.color !== undefined && !isAnnotationColor(data.color))
    throw new AppError(400, '请选择支持的高亮颜色。');
  const color = data.color ?? 'yellow';
  const note = data.note.replace(/\r\n?/g, '\n').trim();
  const location = await sourceLocation(env, nodeId, data.location);
  if (!location) throw new AppError(400, '原文位置信息不正确，请重新选择文字。');
  if (location.kind === 'text' && location.exact.length > ANNOTATION_QUOTE_CHARS * 2)
    throw new AppError(400, '选中的文字过长，请缩小范围后批注。');
  return save(env, nodeId, (annotations) => {
    const now = Date.now();
    const previous = annotations.find((item) => item.id === id);
    if (!previous && annotations.length >= ANNOTATION_COUNT)
      throw new AppError(400, `每个文件最多 ${ANNOTATION_COUNT} 条批注。`);
    const next: Annotation = {
      id,
      quote,
      note,
      color,
      location,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    return previous
      ? annotations.map((item) => (item.id === id ? next : item))
      : [...annotations, next];
  });
}

export async function deleteAnnotation(
  env: Env,
  nodeId: string,
  id: string,
): Promise<AnnotationList> {
  await annotatedNode(env, nodeId);
  const { row, annotations } = await stored(env, nodeId);
  // Already gone, e.g. a repeated request.
  if (!annotations.some((item) => item.id === id))
    return { annotations, updatedAt: row?.updated_at ?? null };
  return save(env, nodeId, (list) => list.filter((item) => item.id !== id));
}
