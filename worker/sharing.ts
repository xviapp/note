import type { ShareSettings } from '../shared/types';
import type { Env } from './types';
import { idValue } from './http';
import { nodePath } from './library';

export async function shareSettings(env: Env): Promise<ShareSettings> {
  const row = await env.DB.prepare(
    'SELECT n.id FROM site s LEFT JOIN nodes n ON n.id=s.share_parent_id AND n.trash_id IS NULL WHERE s.id=1',
  ).first<{ id: string | null }>();
  const parentId = row?.id ?? null;
  return {
    parentId,
    breadcrumbs: parentId
      ? (await nodePath(env, parentId)).map(({ id, title }) => ({ id, title }))
      : [],
  };
}

export async function saveShareSettings(env: Env, data: Record<string, unknown>) {
  const parent = data.parentId === null ? null : idValue(data.parentId);
  // The database guard checks the destination in the write transaction, including concurrent trash.
  await env.DB.prepare('UPDATE site SET share_parent_id=? WHERE id=1').bind(parent).run();
  return shareSettings(env);
}
