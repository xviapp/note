import { GLOBAL_ASSISTANT_ID } from '../shared/assistant';
import {
  backupColumns,
  BACKUP_FORMAT,
  orderBackupNodes,
  rewriteBackupText,
  validateBackup,
  type BackupFile,
  type BackupRow,
  type BackupTable,
  type LibraryBackup,
} from '../shared/backup';
import { AppError, idValue } from './http';
import { LIBRARY_UNREFERENCED, discardFile } from './storage';
import type { Env } from './types';
import { sanitizeSvg } from '../shared/svg';

const DAY = 86400_000;
// D1 allows 2 MB per value and 50 queries per invocation on the free plan.
// Pack by encoded bytes, so large libraries do not consume one query per few rows.
const SQL_VALUE_BYTES = 1_500_000;
const encoder = new TextEncoder();
interface Job {
  id: string;
  kind: string;
  digest: string;
  expires_at: number;
  root_id: string | null;
}
interface RestorePlan {
  archive: LibraryBackup;
  mapping: Record<string, string>;
  root: string;
  trashRoot: string;
}
const parts = (env: Env, id: string, value: unknown) => {
  const bytes = encoder.encode(JSON.stringify(value)),
    statements: D1PreparedStatement[] = [];
  for (let offset = 0, index = 0; offset < bytes.length; index++) {
    let end = Math.min(bytes.length, offset + SQL_VALUE_BYTES);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    statements.push(
      env.DB.prepare('INSERT INTO backup_parts(job_id,part,body) VALUES(?,?,?)').bind(
        id,
        index,
        new TextDecoder().decode(bytes.subarray(offset, end)),
      ),
    );
    offset = end;
  }
  return statements;
};
async function job(env: Env, id: string, kind?: string) {
  const row = await env.DB.prepare('SELECT * FROM backup_jobs WHERE id=? AND expires_at>?')
    .bind(idValue(id), Date.now())
    .first<Job>();
  if (!row || (kind && row.kind !== kind)) throw new AppError(410, '备份任务已过期，请重新开始。');
  return row;
}
async function plan(env: Env, id: string): Promise<RestorePlan> {
  const data = await env.DB.prepare('SELECT body FROM backup_parts WHERE job_id=? ORDER BY part')
    .bind(id)
    .all<{ body: string }>();
  return JSON.parse(data.results.map((part) => part.body).join(''));
}
export async function createBackup(env: Env) {
  const id = crypto.randomUUID(),
    now = Date.now();
  const tables = Object.entries(backupColumns) as [BackupTable, readonly string[]][];
  // Every row and its file lease is captured in the same database transaction.
  // Later edits/deletions cannot make cleanup discard an in-progress download.
  const results = await env.DB.batch<BackupRow>([
    env.DB.prepare("INSERT INTO backup_jobs(id,kind,expires_at) VALUES(?,'export',?)").bind(
      id,
      now + DAY,
    ),
    env.DB.prepare(
      `INSERT INTO backup_files(job_id,source_id,blob_id) SELECT ?,id,id FROM blobs WHERE state='ready' AND NOT (${LIBRARY_UNREFERENCED})`,
    ).bind(id),
    ...tables.map(([table, columns]) =>
      env.DB.prepare(`SELECT ${columns.join(',')} FROM ${table}`),
    ),
    env.DB.prepare(
      'SELECT b.id,b.name,b.mime,b.size,b.created_at FROM blobs b JOIN backup_files f ON f.blob_id=b.id WHERE f.job_id=? ORDER BY b.id',
    ).bind(id),
  ]);
  const archive: LibraryBackup = {
    format: BACKUP_FORMAT,
    version: 1,
    createdAt: now,
    tables: Object.fromEntries(
      tables.map(([name], index) => [name, results[index + 2].results]),
    ) as LibraryBackup['tables'],
    files: results.at(-1)!.results as unknown as BackupFile[],
  };
  try {
    validateBackup(archive);
  } catch (error) {
    await deleteBackup(env, id);
    throw new AppError(400, (error as Error).message);
  }
  return { id, archive };
}
export async function deleteBackup(env: Env, id: string) {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE blobs SET draft_until=? WHERE id IN (SELECT f.blob_id FROM backup_files f JOIN backup_jobs j ON j.id=f.job_id WHERE j.id=? AND j.kind='restore')`,
    ).bind(Date.now(), idValue(id)),
    env.DB.prepare('DELETE FROM backup_jobs WHERE id=?').bind(id),
  ]);
  return { ok: true };
}
export async function startRestore(env: Env, input: unknown, key: string) {
  let archive: LibraryBackup;
  try {
    archive = validateBackup(input);
  } catch (error) {
    throw new AppError(400, (error as Error).message);
  }
  const digest = [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(archive))),
    ),
  ]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  const existing = await env.DB.prepare('SELECT * FROM backup_jobs WHERE id=?')
    .bind(key)
    .first<Job>();
  if (existing) {
    if (existing.kind !== 'restore' || existing.digest !== digest)
      throw new AppError(409, '请重新选择备份文件。');
    await job(env, key, 'restore');
    return { id: key, rootId: existing.root_id };
  }
  const total = archive.files.reduce((sum, file) => sum + file.size, 0);
  const site = await env.DB.prepare(
    'SELECT allocated_bytes,quota_bytes FROM site WHERE id=1',
  ).first<{ allocated_bytes: number; quota_bytes: number }>();
  if (!Number.isSafeInteger(total) || total > site!.quota_bytes - site!.allocated_bytes)
    throw new AppError(413, '恢复所需空间不足，请先调整容量或清理空间。');
  const ids = [
    ...(archive.tables.assistant_messages.some((row) => row.node_id === GLOBAL_ASSISTANT_ID)
      ? [GLOBAL_ASSISTANT_ID]
      : []),
    ...archive.files.map((file) => file.id),
    ...Object.values(archive.tables).flatMap((rows) =>
      rows.filter((r) => r.id).map((r) => String(r.id)),
    ),
  ];
  const restore: RestorePlan = {
    archive,
    mapping: Object.fromEntries(ids.map((id) => [id, crypto.randomUUID()])),
    root: crypto.randomUUID(),
    trashRoot: crypto.randomUUID(),
  };
  const statements = [
    env.DB.prepare(
      "INSERT INTO backup_jobs(id,kind,digest,expires_at) VALUES(?,'restore',?,?)",
    ).bind(key, digest, Date.now() + DAY),
    ...parts(env, key, restore),
    ...inserts(
      env,
      'backup_files',
      ['job_id', 'source_id'],
      archive.files.map((file) => ({ job_id: key, source_id: file.id })),
    ),
  ];
  await restoreBatch(env, statements);
  return { id: key, rootId: null };
}
export async function uploadRestoreFile(
  env: Env,
  request: Request,
  jobId: string,
  sourceId: string,
) {
  const state = await job(env, jobId, 'restore');
  if (state.root_id) return { ok: true };
  const restore = await plan(env, jobId);
  const file = restore.archive.files.find((file) => file.id === idValue(sourceId));
  if (!file || !Object.hasOwn(restore.mapping, sourceId))
    throw new AppError(400, '备份中没有此文件。');
  const id = restore.mapping[sourceId];
  const existing = await env.DB.prepare('SELECT state FROM blobs WHERE id=?')
    .bind(id)
    .first<{ state: string }>();
  if (existing?.state === 'ready') return { ok: true };
  if (existing) throw new AppError(409, '此文件仍在上传，请稍后重试。');
  if (!request.body && file.size !== 0) throw new AppError(400, '文件内容缺失。');
  const incoming = request.body || new Blob([]).stream();
  let content: Uint8Array | ReadableStream<Uint8Array> = incoming;
  let size = file.size;
  const textual = /^(text\/|application\/json|image\/svg\+xml)/.test(file.mime);
  if (textual) {
    if (size > 16 * 1024 * 1024) throw new AppError(413, '单份正文超过允许大小。');
    const reader = incoming.getReader(),
      chunks: Uint8Array[] = [];
    let received = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        received += part.value.length;
        if (received > size) throw new AppError(400, '文件大小与清单不符。');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (received !== size) throw new AppError(400, '文件未完整上传。');
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    text =
      file.mime === 'image/svg+xml' ? sanitizeSvg(bytes) : rewriteBackupText(text, restore.mapping);
    content = new TextEncoder().encode(text);
    size = content.length;
    if (size > 16 * 1024 * 1024) throw new AppError(413, '恢复后的正文超过允许大小。');
  }
  const now = Date.now(),
    objectKey = `objects/${id}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO blobs(id,object_key,name,mime,size,state,draft_until,created_at) VALUES(?,?,?,?,?,'pending',?,?)",
    ).bind(id, objectKey, file.name, file.mime, size, now + DAY, file.created_at),
    env.DB.prepare('UPDATE backup_files SET blob_id=? WHERE job_id=? AND source_id=?').bind(
      id,
      jobId,
      sourceId,
    ),
  ]);
  const transfer = new AbortController();
  let transfers: Promise<unknown>[] = [];
  try {
    if (content instanceof Uint8Array)
      await env.FILES.put(objectKey, content, { httpMetadata: { contentType: file.mime } });
    else {
      const stream = new FixedLengthStream(size);
      const pump = content.pipeTo(stream.writable, { signal: transfer.signal });
      const put = env.FILES.put(objectKey, stream.readable, {
        httpMetadata: { contentType: file.mime },
      });
      transfers = [pump, put];
      await Promise.all(transfers);
    }
    const finished = await env.DB.prepare(
      "UPDATE blobs SET state='ready' WHERE id=? AND state='pending' AND EXISTS(SELECT 1 FROM backup_files WHERE job_id=? AND blob_id=?) RETURNING id",
    )
      .bind(id, jobId, id)
      .first();
    if (!finished) throw new AppError(409, '恢复任务已结束，请重新开始。');
    return { ok: true };
  } catch {
    transfer.abort();
    await Promise.allSettled(transfers);
    await env.DB.prepare('UPDATE backup_files SET blob_id=NULL WHERE job_id=? AND source_id=?')
      .bind(jobId, sourceId)
      .run();
    await discardFile(env, id).catch(() => {});
    // Pending uploads are also removed after a failed transfer.
    await env.FILES.delete(objectKey).catch(() => {});
    await env.DB.prepare("DELETE FROM blobs WHERE id=? AND state='pending'").bind(id).run();
    throw new AppError(400, '文件上传中断，请重试恢复。');
  }
}
function inserts(env: Env, table: string, columns: readonly string[], rows: BackupRow[]) {
  const statements: D1PreparedStatement[] = [];
  let chunk: string[] = [],
    bytes = 2;
  const flush = () => {
    if (!chunk.length) return;
    statements.push(
      env.DB.prepare(
        `INSERT INTO ${table}(${columns.join(',')}) SELECT ${columns.map((column) => `json_extract(value,'$.${column}')`).join(',')} FROM json_each(?) ORDER BY CAST(key AS INTEGER)`,
      ).bind(`[${chunk.join(',')}]`),
    );
    chunk = [];
    bytes = 2;
  };
  for (const row of rows) {
    const text = JSON.stringify(
      Object.fromEntries(columns.map((column) => [column, row[column] ?? null])),
    );
    const size = encoder.encode(text).length + 1;
    if (size + 2 > SQL_VALUE_BYTES) throw new AppError(413, '单条备份记录过大。');
    if (bytes + size > SQL_VALUE_BYTES) flush();
    chunk.push(text);
    bytes += size;
  }
  flush();
  return statements;
}
async function restoreBatch(env: Env, statements: D1PreparedStatement[]) {
  // Leave room for authentication and job queries within the same invocation.
  if (statements.length > 40) throw new AppError(413, '备份记录过多，超过单次恢复上限。');
  return env.DB.batch(statements);
}
export async function finishRestore(env: Env, jobId: string) {
  const state = await job(env, jobId, 'restore');
  if (state.root_id) return { rootId: state.root_id };
  const restore = await plan(env, jobId),
    { archive, mapping, root, trashRoot } = restore;
  const pending = await env.DB.prepare(
    "SELECT COUNT(*) count FROM backup_files f LEFT JOIN blobs b ON b.id=f.blob_id WHERE f.job_id=? AND (b.id IS NULL OR b.state!='ready')",
  )
    .bind(jobId)
    .first<{ count: number }>();
  if (pending!.count) throw new AppError(409, '还有文件没有上传完成，请重试恢复。');
  const mapped = (value: string | number | null) =>
    typeof value === 'string' && Object.hasOwn(mapping, value) ? mapping[value] : value;
  const rewrite = (row: BackupRow): BackupRow =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        key === 'id' || (key.endsWith('_id') && key !== 'request_id') ? mapped(value) : value,
      ]),
    );
  const now = Date.now(),
    nodes = orderBackupNodes(archive.tables.nodes);
  const originals = new Map(nodes.map((node) => [node.id, node]));
  const hasTrash = nodes.some((node) => node.trash_id !== null);
  const folder = (id: string, title: string, parent: string | null): BackupRow => ({
    id,
    title,
    parent_id: parent,
    kind: 'folder',
    position: 0,
    url: null,
    arxiv_id: null,
    file_blob_id: null,
    icon_emoji: null,
    icon_blob_id: null,
    current_version_id: null,
    revision: 1,
    trash_id: null,
    created_at: now,
    updated_at: now,
  });
  const restoredNodes: BackupRow[] = nodes.map((node) => ({
    ...rewrite(node),
    trash_id: null,
    parent_id:
      node.trash_id !== null && originals.get(node.parent_id)?.trash_id !== node.trash_id
        ? trashRoot
        : node.parent_id
          ? mapped(node.parent_id)
          : node.trash_id !== null
            ? trashRoot
            : root,
  }));
  if (mapping[GLOBAL_ASSISTANT_ID])
    restoredNodes.push({
      ...folder(mapping[GLOBAL_ASSISTANT_ID], '青藜全局对话（恢复）', root),
      kind: 'text',
    });
  const rows: Record<BackupTable, BackupRow[]> = {
    ...archive.tables,
    nodes: [
      folder(root, `备份恢复 ${new Date(archive.createdAt).toISOString().slice(0, 10)}`, null),
      ...(hasTrash ? [folder(trashRoot, '原回收站', root)] : []),
      ...restoredNodes,
    ],
    versions: archive.tables.versions.map(rewrite),
    version_assets: archive.tables.version_assets.map(rewrite),
    favorites: archive.tables.favorites.map(rewrite),
    reading_states: archive.tables.reading_states.map((row) => ({
      ...rewrite(row),
      position: rewriteBackupText(String(row.position), mapping),
    })),
    assistant_threads: [
      ...new Set(archive.tables.assistant_messages.map((m) => String(m.node_id))),
    ].map((node_id) => ({ node_id: mapped(node_id) })),
    assistant_messages: [...archive.tables.assistant_messages]
      .sort((a, b) => Number(a.sequence) - Number(b.sequence))
      .map((row) => ({
        ...rewrite(row),
        exported_node_id: originals.has(row.exported_node_id) ? mapped(row.exported_node_id) : null,
        status: row.status === 'pending' ? 'interrupted' : row.status,
      })),
    assistant_message_files: archive.tables.assistant_message_files.map(rewrite),
    translations: archive.tables.translations.map(rewrite),
    paper_translations: archive.tables.paper_translations.map(rewrite),
    annotations: archive.tables.annotations.map(rewrite),
    books: archive.tables.books.map(rewrite),
    trash_batches: [],
  };
  const statements = [
    ...inserts(
      env,
      'backup_restore_nodes',
      ['node_id'],
      restoredNodes.map((n) => ({ node_id: n.id })),
    ),
    ...Object.entries(backupColumns)
      .filter(([table]) => table !== 'trash_batches')
      .flatMap(([table, columns]) =>
        inserts(
          env,
          table,
          table === 'assistant_messages'
            ? columns.filter((column) => column !== 'sequence')
            : columns,
          rows[table as BackupTable],
        ),
      ),
    // No other transaction can observe or add rows in this temporary guard set.
    env.DB.prepare('DELETE FROM backup_restore_nodes'),
    env.DB.prepare('UPDATE backup_jobs SET root_id=? WHERE id=?').bind(root, jobId),
    env.DB.prepare('DELETE FROM backup_files WHERE job_id=?').bind(jobId),
  ];
  try {
    await restoreBatch(env, statements);
  } catch (error) {
    const repeated = await job(env, jobId, 'restore');
    if (repeated.root_id) return { rootId: repeated.root_id };
    throw error;
  }
  return { rootId: root };
}
