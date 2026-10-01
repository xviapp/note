import type { BlobRow, Env } from './types';
import type { TrashBatch } from '../shared/types';
import { AppError, integer } from './http';
import { getNode } from './library';
import { UNREFERENCED } from './storage';

export async function deletePreview(
  env: Env,
  id: string,
): Promise<{ count: number; title: string }> {
  const node = await getNode(env, id);
  const row = await env.DB.prepare(
    `WITH RECURSIVE subtree(id) AS(SELECT id FROM nodes WHERE id=? AND trash_id IS NULL UNION ALL SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id=s.id WHERE n.trash_id IS NULL) SELECT COUNT(*) count FROM subtree`,
  )
    .bind(id)
    .first<{ count: number }>();
  return { count: row!.count, title: node.title };
}
export async function trashNode(env: Env, id: string, count: unknown): Promise<{ id: string }> {
  const node = await getNode(env, id),
    expected = integer(count, '删除数量', 1),
    batch = crypto.randomUUID(),
    now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO trash_batches(id,root_id,title,original_parent_id,expected_count,deleted_at,expires_at) VALUES(?,?,?,?,?,?,?)',
    ).bind(batch, id, node.title, node.parent_id, expected, now, now + 7 * 86400_000),
    env.DB.prepare(
      `WITH RECURSIVE subtree(id) AS(SELECT id FROM nodes WHERE id=? AND trash_id IS NULL UNION ALL SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id=s.id WHERE n.trash_id IS NULL) UPDATE nodes SET trash_id=?,revision=revision+1 WHERE id IN(SELECT id FROM subtree)`,
    ).bind(id, batch),
  ]);
  return { id: batch };
}
export async function listTrash(env: Env): Promise<TrashBatch[]> {
  return (
    await env.DB.prepare(
      'SELECT t.*,(SELECT COUNT(*) FROM nodes WHERE trash_id=t.id) node_count FROM trash_batches t ORDER BY deleted_at DESC',
    ).all<TrashBatch>()
  ).results;
}
export async function restoreTrash(
  env: Env,
  id: string,
): Promise<{ rootId: string; movedToRoot: boolean }> {
  const batch = await env.DB.prepare(
    'SELECT * FROM trash_batches WHERE id=? AND purging=0 AND expires_at>?',
  )
    .bind(id, Date.now())
    .first<TrashBatch>();
  if (!batch) throw new AppError(410, '回收站保留期已结束，或此项正在永久删除。');
  const root = await getNode(env, batch.root_id, true);
  let moved = false;
  if (root.parent_id) {
    const parent = await env.DB.prepare('SELECT id FROM nodes WHERE id=? AND trash_id IS NULL')
      .bind(root.parent_id)
      .first();
    moved = !parent;
  }
  // Check the deadline in the same transaction using a guarded batch update. A concurrent purge
  // wins atomically, so we never revive rows already scheduled for deletion.
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE trash_batches SET purging=-1 WHERE id=? AND purging=0 AND expires_at>?',
    ).bind(id, Date.now()),
    env.DB.prepare(
      `UPDATE nodes SET parent_id=NULL WHERE id=? AND trash_id=? AND EXISTS(SELECT 1 FROM trash_batches WHERE id=? AND purging=-1) AND (parent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM nodes p WHERE p.id=nodes.parent_id AND p.trash_id IS NULL))`,
    ).bind(batch.root_id, id, id),
    env.DB.prepare(
      'UPDATE nodes SET trash_id=NULL,revision=revision+1 WHERE trash_id=? AND EXISTS(SELECT 1 FROM trash_batches WHERE id=? AND purging=-1)',
    ).bind(id, id),
    env.DB.prepare('DELETE FROM trash_batches WHERE id=? AND purging=-1').bind(id),
  ]);
  const result = await getNode(env, batch.root_id, true);
  if (result.trash_id) throw new AppError(410, '此项已经进入永久删除流程。');
  return {
    rootId: batch.root_id,
    movedToRoot: moved || Boolean(batch.original_parent_id && !result.parent_id),
  };
}
export async function purgeTrash(env: Env, id: string): Promise<void> {
  const row = await env.DB.prepare(
    'UPDATE trash_batches SET purging=1 WHERE id=? AND purging=0 RETURNING id',
  )
    .bind(id)
    .first();
  if (!row) throw new AppError(404, '此项不存在或正在清理。');
  await purgeBatch(env, id);
}
async function purgeBatch(env: Env, id: string): Promise<void> {
  // ON DELETE SET NULL preserves descendants belonging to a separate trash batch.
  await env.DB.batch([
    env.DB.prepare(
      'DELETE FROM nodes WHERE id IN(SELECT id FROM nodes WHERE trash_id=? LIMIT 50)',
    ).bind(id),
    env.DB.prepare(
      'DELETE FROM trash_batches WHERE id=? AND NOT EXISTS(SELECT 1 FROM nodes WHERE trash_id=?)',
    ).bind(id, id),
  ]);
}
export async function cleanup(env: Env): Promise<{ removed: number }> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('UPDATE trash_batches SET purging=1 WHERE expires_at<=? AND purging=0').bind(
      now,
    ),
    env.DB.prepare(
      'DELETE FROM sessions WHERE expires_at<=? OR epoch!=(SELECT auth_epoch FROM site WHERE id=1)',
    ).bind(now),
    env.DB.prepare('DELETE FROM login_attempts WHERE window_start<?').bind(now - 3600_000),
    env.DB.prepare('DELETE FROM idempotency WHERE created_at<?').bind(now - 7 * 86400_000),
    env.DB.prepare(
      'DELETE FROM translations WHERE id IN (SELECT id FROM translations WHERE body_blob_id IS NULL AND locked_until<=? AND updated_at<? LIMIT 50)',
    ).bind(now, now - 7 * 86400_000),
  ]);
  const batches = await env.DB.prepare('SELECT id FROM trash_batches WHERE purging=1 LIMIT 3').all<{
    id: string;
  }>();
  for (const batch of batches.results) await purgeBatch(env, batch.id);
  const files = await env.DB.prepare(
    `UPDATE blobs SET state='deleting' WHERE id IN(
    SELECT id FROM blobs WHERE ${UNREFERENCED} AND (state='deleting' OR draft_until IS NULL OR draft_until<=?) LIMIT 10
  ) RETURNING *`,
  )
    .bind(now)
    .all<BlobRow>();
  let removed = 0;
  for (const file of files.results) {
    try {
      await env.FILES.delete(file.object_key);
      await env.DB.prepare("DELETE FROM blobs WHERE id=? AND state='deleting'").bind(file.id).run();
      removed++;
    } catch {
      /* Retain the durable deleting marker; next sweep retries. */
    }
  }
  return { removed };
}
