import type { NodeKind } from '../shared/types';
import { searchText } from '../shared/search-text';
import { KEY_SQL } from './library';
import { readText } from './storage';
import type { Env } from './types';

// Full-text search over note bodies. `note_text` keeps the current body of each
// unencrypted Markdown or text note as plain text, with the version it came
// from; `note_text_index` is its trigram index (migrations/0024_note_text.sql).
// Saves write it in the same batch as the version; indexPending() fills in what
// is missing (notes from before the index, restored backups, decrypted notes).
// Encrypted notes are never indexed, and search checks the key again on read.

// Whether the version is the note's current one and still plain: no key for
// the note, none on the body, and (when given) the same object that was read.
// Encrypting re-seals bodies in place under the same version, so a body read
// before that must not be written after it.
const currentPlain = () => `EXISTS(SELECT 1 FROM nodes n JOIN versions v ON v.id=n.current_version_id
  JOIN blobs b ON b.id=v.body_blob_id
  WHERE n.id=? AND n.current_version_id=? AND b.key_id IS NULL AND (? IS NULL OR b.object_key=?)
    AND ${KEY_SQL('n')} IS NULL)`;
// Writes a note's body for its current version; a version that is no longer
// current (a newer save won) or no longer plain is not written.
export function indexStatement(
  env: Env,
  nodeId: string,
  versionId: string,
  kind: NodeKind,
  content: string,
  objectKey: string | null = null,
) {
  return env.DB.prepare(
    `INSERT INTO note_text(node_id,version_id,body,retry_at,attempts)
     SELECT ?,?,?,NULL,0 WHERE ${currentPlain()}
     ON CONFLICT(node_id) DO UPDATE SET version_id=excluded.version_id,body=excluded.body,retry_at=NULL,attempts=0`,
  ).bind(nodeId, versionId, searchText(kind, content), nodeId, versionId, objectKey, objectKey);
}
// A body that could not be read: kept out of search until a later try reads
// it. After RETRIES failed reads it is indexed empty and left alone.
const RETRIES = 8;
function failedStatement(env: Env, nodeId: string, versionId: string, attempts: number, now: number) {
  const retryAt = attempts < RETRIES ? now + Math.min(30 * 60_000 * 2 ** (attempts - 1), 86400_000) : null;
  return env.DB.prepare(
    `INSERT INTO note_text(node_id,version_id,body,retry_at,attempts)
     SELECT ?,?,'',?,? WHERE ${currentPlain()}
     ON CONFLICT(node_id) DO UPDATE SET version_id=excluded.version_id,body='',retry_at=excluded.retry_at,attempts=excluded.attempts`,
  ).bind(nodeId, versionId, retryAt, attempts, nodeId, versionId, null, null);
}
export function forgetStatement(env: Env, nodeId: string) {
  return env.DB.prepare('DELETE FROM note_text WHERE node_id=?').bind(nodeId);
}
// A folder that became encrypted (or a note moved into one) drops its plain
// text at once; notes below it that stay unencrypted are indexed again later.
export async function forgetSubtree(env: Env, rootId: string) {
  await env.DB.prepare(
    `WITH RECURSIVE below(id,depth) AS (
       SELECT ?,0 UNION ALL SELECT n.id,b.depth+1 FROM nodes n JOIN below b ON n.parent_id=b.id WHERE b.depth<200
     ) DELETE FROM note_text WHERE node_id IN (SELECT id FROM below)`,
  )
    .bind(rootId)
    .run();
}

// Indexes up to `limit` notes whose current body is not indexed yet. Small
// batches keep each call within the Workers Free limits (queries and CPU).
export async function indexPending(env: Env, limit: number): Promise<{ indexed: number; more: boolean }> {
  // Bodies that were sealed in place since they were indexed.
  await env.DB.prepare(
    `DELETE FROM note_text WHERE node_id IN (
       SELECT t.node_id FROM note_text t JOIN nodes n ON n.id=t.node_id
       JOIN versions v ON v.id=n.current_version_id JOIN blobs b ON b.id=v.body_blob_id
       WHERE b.key_id IS NOT NULL)`,
  ).run();
  const now = Date.now();
  // Bodies never read first; failed reads once they are due.
  const pending = await env.DB.prepare(
    `SELECT n.id,n.kind,n.current_version_id version_id,v.body_blob_id,b.object_key,
       CASE WHEN t.version_id=n.current_version_id THEN t.attempts ELSE 0 END attempts FROM nodes n
     JOIN versions v ON v.id=n.current_version_id JOIN blobs b ON b.id=v.body_blob_id
     LEFT JOIN note_text t ON t.node_id=n.id
     WHERE n.kind IN ('markdown','text') AND n.arxiv_id IS NULL AND b.key_id IS NULL
       AND (t.version_id IS NULL OR t.version_id<>n.current_version_id OR t.retry_at<=?)
       AND ${KEY_SQL('n')} IS NULL
     ORDER BY t.retry_at IS NOT NULL,t.retry_at LIMIT ?`,
  )
    .bind(now, limit)
    .all<{ id: string; kind: NodeKind; version_id: string; body_blob_id: string; object_key: string; attempts: number }>();
  if (!pending.results.length) return { indexed: 0, more: false };
  let indexed = 0;
  const statements = await Promise.all(
    pending.results.map(async (row) => {
      try {
        const content = await readText(env, row.body_blob_id);
        indexed++;
        return indexStatement(env, row.id, row.version_id, row.kind, content, row.object_key);
      } catch {
        return failedStatement(env, row.id, row.version_id, row.attempts + 1, now);
      }
    }),
  );
  await env.DB.batch(statements);
  return { indexed, more: statements.length === limit };
}

// The SQL that requires every word in the body, and its parameters. Words of
// three or more characters use the trigram index (a quoted phrase matches any
// substring, ignoring ASCII case); shorter ones are matched by scanning.
export function bodyMatch(words: string[]): { from: string; where: string[]; params: string[] } {
  const long = words.filter((word) => [...word].length >= 3),
    short = words.filter((word) => [...word].length < 3);
  const pattern = (word: string) => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return {
    from: long.length
      ? 'note_text_index JOIN note_text t ON t.rowid=note_text_index.rowid'
      : 'note_text t',
    where: [
      ...(long.length ? ['note_text_index MATCH ?'] : []),
      ...short.map(() => "t.body LIKE ? ESCAPE '\\'"),
    ],
    params: [
      ...(long.length ? [long.map((word) => `"${word.replace(/"/g, '""')}"`).join(' AND ')] : []),
      ...short.map(pattern),
    ],
  };
}

// Context around the first word: SQL picks the slice (so whole bodies never
// leave D1) and this marks where it was cut.
export const EXCERPT_SQL = (word: string) => ({
  sql: `substr(t.body,max(1,instr(lower(t.body),lower(?))-30),140) excerpt,
    instr(lower(t.body),lower(?)) excerpt_at,length(t.body) body_length`,
  params: [word, word],
});
export function excerpt(piece: string, at: number, length: number): string {
  const start = Math.max(1, at - 30);
  const line = piece.replace(/\s+/g, ' ').trim();
  return `${start > 1 ? '…' : ''}${line}${start + 140 <= length ? '…' : ''}`;
}
