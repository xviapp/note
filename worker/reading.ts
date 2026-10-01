import type { Env } from './types';
import type { ReadingPosition, ReadingState } from '../shared/types';
import { getNode } from './library';
import { AppError, integer } from './http';

export async function favorite(env: Env, id: string, enabled: unknown): Promise<void> {
  await getNode(env, id);
  if (typeof enabled !== 'boolean') throw new AppError(400, '收藏状态不正确。');
  if (enabled)
    await env.DB.prepare(
      'INSERT INTO favorites(node_id,created_at) VALUES(?,?) ON CONFLICT(node_id) DO NOTHING',
    )
      .bind(id, Date.now())
      .run();
  else await env.DB.prepare('DELETE FROM favorites WHERE node_id=?').bind(id).run();
}
export async function openReading(env: Env, id: string): Promise<ReadingState> {
  await getNode(env, id);
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO reading_states(node_id,last_opened_at,updated_at) VALUES(?,?,?)
    ON CONFLICT(node_id) DO UPDATE SET last_opened_at=excluded.last_opened_at RETURNING position,version,updated_at`,
  )
    .bind(id, now, now)
    .first<{ position: string; version: number; updated_at: number }>();
  return { ...row!, position: JSON.parse(row!.position) };
}
export async function readingState(env: Env, id: string): Promise<ReadingState> {
  await getNode(env, id);
  const row = await env.DB.prepare(
    'SELECT position,version,updated_at FROM reading_states WHERE node_id=?',
  )
    .bind(id)
    .first<{ position: string; version: number; updated_at: number }>();
  return row
    ? { ...row, position: JSON.parse(row.position) }
    : { position: {}, version: 0, updated_at: 0 };
}
export async function saveReading(
  env: Env,
  id: string,
  data: Record<string, unknown>,
): Promise<ReadingState> {
  await getNode(env, id);
  const version = integer(data.version, '阅读位置版本');
  if (!data.position || typeof data.position !== 'object' || Array.isArray(data.position))
    throw new AppError(400, '阅读位置不正确。');
  const input = data.position as ReadingPosition,
    position: ReadingPosition = {};
  if (input.ratio !== undefined) {
    if (
      typeof input.ratio !== 'number' ||
      !Number.isFinite(input.ratio) ||
      input.ratio < 0 ||
      input.ratio > 1
    )
      throw new AppError(400, '阅读比例不正确。');
    position.ratio = input.ratio;
  }
  if (input.heading !== undefined) {
    if (typeof input.heading !== 'string' || input.heading.length > 300)
      throw new AppError(400, '阅读标题不正确。');
    position.heading = input.heading;
  }
  if (input.headingRatio !== undefined) {
    if (
      typeof input.headingRatio !== 'number' ||
      !Number.isFinite(input.headingRatio) ||
      input.headingRatio < 0 ||
      input.headingRatio > 1
    )
      throw new AppError(400, '标题内阅读位置不正确。');
    position.headingRatio = input.headingRatio;
  }
  if (input.page !== undefined) position.page = integer(input.page, 'PDF 页码', 1, 100000);
  if (input.pageRatio !== undefined) {
    if (
      typeof input.pageRatio !== 'number' ||
      !Number.isFinite(input.pageRatio) ||
      input.pageRatio < 0 ||
      input.pageRatio > 1
    )
      throw new AppError(400, '页内位置不正确。');
    position.pageRatio = input.pageRatio;
  }
  const now = Date.now();
  const row = await env.DB.prepare(
    'UPDATE reading_states SET position=?,version=version+1,updated_at=? WHERE node_id=? AND version=? RETURNING position,version,updated_at',
  )
    .bind(JSON.stringify(position), now, id, version)
    .first<{ position: string; version: number; updated_at: number }>();
  if (!row)
    throw new AppError(409, '另一设备已更新阅读位置，旧位置未覆盖新位置。', 'READING_CONFLICT');
  return { ...row, position: JSON.parse(row.position) };
}
