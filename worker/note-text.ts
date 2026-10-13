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

// Writes a note's body for its current version; a version that is no longer
// current (a newer save won) is not written.
export function indexStatement(
  env: Env,
  nodeId: string,
  versionId: string,
  kind: NodeKind,
  content: string,
) {
  return env.DB.prepare(
    `INSERT INTO note_text(node_id,version_id,body)
     SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM nodes WHERE id=? AND current_version_id=?)
     ON CONFLICT(node_id) DO UPDATE SET version_id=excluded.version_id,body=excluded.body`,
  ).bind(nodeId, versionId, searchText(kind, content), nodeId, versionId);
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
  const pending = await env.DB.prepare(
    `SELECT n.id,n.kind,n.current_version_id version_id,v.body_blob_id FROM nodes n
     JOIN versions v ON v.id=n.current_version_id JOIN blobs b ON b.id=v.body_blob_id
     LEFT JOIN note_text t ON t.node_id=n.id
     WHERE n.kind IN ('markdown','text') AND n.arxiv_id IS NULL AND b.key_id IS NULL
       AND (t.version_id IS NULL OR t.version_id<>n.current_version_id) AND ${KEY_SQL('n')} IS NULL
     LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string; kind: NodeKind; version_id: string; body_blob_id: string }>();
  if (!pending.results.length) return { indexed: 0, more: false };
  const statements = await Promise.all(
    pending.results.map(async (row) => {
      // An unreadable body is indexed empty, so it is not retried forever.
      const content = await readText(env, row.body_blob_id).catch(() => '');
      return indexStatement(env, row.id, row.version_id, row.kind, content);
    }),
  );
  await env.DB.batch(statements);
  return { indexed: statements.length, more: statements.length === limit };
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
