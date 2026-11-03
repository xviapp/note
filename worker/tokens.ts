import type { ApiToken } from '../shared/types';
import { digest, getSite, randomToken } from './auth';
import { AppError, body, json, textValue } from './http';
import type { Env, Session } from './types';

const PREFIX = 'xvi_';
const MAX_TOKENS = 20;
const USE_RESOLUTION_MS = 3600_000;
const ID = '[a-zA-Z0-9_-]+';
// What a token may reach: reading notes, and with write scope editing them and
// moving them to the trash. Account, backup, key and AI settings stay with a
// signed-in browser, as does anything that cannot be undone.
const READ: [string, RegExp][] = [
  ['GET', /^\/api\/nodes$/],
  ['GET', new RegExp(`^/api/nodes/${ID}$`)],
  ['GET', new RegExp(`^/api/nodes/${ID}/delete-preview$`)],
  ['GET', new RegExp(`^/api/files/${ID}$`)],
  ['GET', /^\/api\/search$/],
  // Wrapped: they are of no use without the encryption password.
  ['GET', /^\/api\/encryption\/keys$/],
  ['DELETE', /^\/api\/tokens\/current$/],
];
const WRITE: [string, RegExp][] = [
  ['POST', /^\/api\/edit\/unlock$/],
  ['POST', /^\/api\/nodes$/],
  ['POST', /^\/api\/files$/],
  ['PATCH', new RegExp(`^/api/nodes/${ID}$`)],
  ['DELETE', new RegExp(`^/api/nodes/${ID}$`)],
  ['PUT', new RegExp(`^/api/nodes/${ID}/content$`)],
];
const matches = (rules: [string, RegExp][], method: string, path: string) =>
  rules.some(([allowed, pattern]) => allowed === method && pattern.test(path));
export function requireTokenScope(session: Session, method: string, path: string): void {
  if (!session.token_scope) return;
  if (matches(READ, method, path)) return;
  if (session.token_scope === 'write' && matches(WRITE, method, path)) return;
  throw new AppError(403, '命令行令牌不能执行此操作。', 'TOKEN_SCOPE');
}
export async function findTokenSession(token: string, env: Env): Promise<Session | null> {
  if (!token.startsWith(PREFIX) || token.length > 128) return null;
  const row = await env.DB.prepare(
    `SELECT t.id,t.token_hash,t.epoch,t.scope,t.last_used_at FROM api_tokens t JOIN site c ON c.id=1
     WHERE t.token_hash=? AND t.epoch=c.auth_epoch AND c.password_hash IS NOT NULL`,
  )
    .bind(await digest(token))
    .first<{
      id: string;
      token_hash: string;
      epoch: number;
      scope: 'read' | 'write';
      last_used_at: number | null;
    }>();
  if (!row) return null;
  const now = Date.now();
  if (!row.last_used_at || now - row.last_used_at > USE_RESOLUTION_MS)
    await env.DB.prepare('UPDATE api_tokens SET last_used_at=? WHERE id=?').bind(now, row.id).run();
  return {
    token_hash: row.token_hash,
    epoch: row.epoch,
    expires_at: Number.MAX_SAFE_INTEGER,
    token_id: row.id,
    token_scope: row.scope,
  };
}
async function listTokens(env: Env): Promise<{ tokens: ApiToken[] }> {
  const tokens = await env.DB.prepare(
    `SELECT id,name,scope,created_at,last_used_at FROM api_tokens
     WHERE epoch=(SELECT auth_epoch FROM site WHERE id=1) ORDER BY created_at DESC,id`,
  ).all<ApiToken>();
  return { tokens: tokens.results };
}
async function createToken(env: Env, data: Record<string, unknown>) {
  const name = textValue(data.name, '令牌名称', 80).trim();
  if (data.scope !== 'read' && data.scope !== 'write') throw new AppError(400, '令牌权限不正确。');
  const site = await getSite(env);
  const { tokens } = await listTokens(env);
  if (tokens.length >= MAX_TOKENS) throw new AppError(409, '令牌过多，请先在设置中撤销不用的令牌。');
  const id = crypto.randomUUID(),
    token = `${PREFIX}${randomToken()}`,
    now = Date.now();
  await env.DB.prepare(
    'INSERT INTO api_tokens(id,name,token_hash,scope,epoch,created_at) VALUES(?,?,?,?,?,?)',
  )
    .bind(id, name, await digest(token), data.scope, site.auth_epoch, now)
    .run();
  return { id, token };
}
const revoke = (env: Env, id: string) =>
  env.DB.prepare('DELETE FROM api_tokens WHERE id=?').bind(id).run();
export async function tokenRoutes(
  request: Request,
  env: Env,
  session: Session,
  path: string,
): Promise<Response | null> {
  const method = request.method;
  if (path === '/api/tokens/current' && method === 'DELETE') {
    if (session.token_id) await revoke(env, session.token_id);
    return json({ ok: true });
  }
  if (path === '/api/tokens' && method === 'GET') return json(await listTokens(env));
  if (path === '/api/tokens' && method === 'POST')
    return json(await createToken(env, await body(request)), 201);
  const one = path.match(new RegExp(`^/api/tokens/(${ID})$`));
  if (one && method === 'DELETE') {
    await revoke(env, one[1]);
    return json({ ok: true });
  }
  return null;
}
