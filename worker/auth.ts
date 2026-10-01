import type { Env, Session, Site } from './types';
import { AppError, body, json, textValue } from './http';

const encoder = new TextEncoder();
export const PASSWORD_ITERATIONS = 600_000;
const SESSION_MS = 30 * 86400_000;
export const COOKIE = 'note_session';
export const randomToken = (length = 32) => base64(crypto.getRandomValues(new Uint8Array(length)));
export function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}
export async function digest(value: string): Promise<string> {
  return base64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}
export async function passwordHash(
  password: string,
  salt: string,
  iterations = PASSWORD_ITERATIONS,
): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  return base64(
    new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(salt), iterations },
        key,
        256,
      ),
    ),
  );
}
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}
function validatePassword(password: unknown): string {
  const value = textValue(password, '密码', 256);
  if ([...value].length < 12)
    throw new AppError(400, '请设置至少 12 个字符的密码，可以使用容易记住的长句。');
  return value;
}
export async function getSite(env: Env): Promise<Site> {
  const site = await env.DB.prepare('SELECT * FROM site WHERE id=1').first<Site>();
  if (!site) throw new AppError(503, '数据库尚未初始化，请先执行数据库迁移。');
  return site;
}
function configured(env: Env): void {
  if (
    !env.APP_SECRET ||
    env.APP_SECRET.length < 32 ||
    !env.SETUP_TOKEN ||
    env.SETUP_TOKEN.length < 32
  )
    throw new AppError(503, '站点尚未配置，请先运行初始化配置命令。', 'NOT_CONFIGURED');
}
function cookie(request: Request, token: string, maxAge = SESSION_MS / 1000): string {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname);
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${local && new URL(request.url).protocol === 'http:' ? '' : '; Secure'}`;
}
export async function findSession(request: Request, env: Env): Promise<Session | null> {
  const token = request.headers
    .get('cookie')
    ?.split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!token || token.length > 128) return null;
  return env.DB.prepare(
    'SELECT s.token_hash,s.epoch,s.expires_at FROM sessions s JOIN site c ON c.id=1 WHERE s.token_hash=? AND s.expires_at>? AND s.epoch=c.auth_epoch AND c.password_hash IS NOT NULL',
  )
    .bind(await digest(token), Date.now())
    .first<Session>();
}
export async function requireSession(request: Request, env: Env): Promise<Session> {
  const session = await findSession(request, env);
  if (!session) throw new AppError(401, '登录已失效，请重新输入密码。', 'UNAUTHENTICATED');
  return session;
}
async function throttle(request: Request, env: Env): Promise<string> {
  const key = await digest(
    `${env.APP_SECRET}:${request.headers.get('cf-connecting-ip') ?? 'local'}`,
  );
  const now = Date.now(),
    window = 60_000;
  const rows = await env.DB.batch<{ attempts: number }>([
    env.DB.prepare(
      'INSERT INTO login_attempts(key,attempts,window_start) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start<? THEN 1 ELSE attempts+1 END, window_start=CASE WHEN window_start<? THEN excluded.window_start ELSE window_start END RETURNING attempts',
    ).bind(key, now, now - window, now - window),
    env.DB.prepare(
      "INSERT INTO login_attempts(key,attempts,window_start) VALUES('global',1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start<? THEN 1 ELSE attempts+1 END, window_start=CASE WHEN window_start<? THEN excluded.window_start ELSE window_start END RETURNING attempts",
    ).bind(now, now - window, now - window),
  ]);
  if (Number(rows[0].results[0]?.attempts) > 8 || Number(rows[1].results[0]?.attempts) > 40)
    throw new AppError(429, '尝试过于频繁，请一分钟后再试。', 'RATE_LIMITED');
  return key;
}
async function issueSession(request: Request, env: Env, epoch: number): Promise<Response> {
  const token = randomToken(),
    now = Date.now();
  await env.DB.prepare(
    'INSERT INTO sessions(token_hash,epoch,created_at,expires_at) VALUES(?,?,?,?)',
  )
    .bind(await digest(token), epoch, now, now + SESSION_MS)
    .run();
  return json({ ok: true }, 200, { 'set-cookie': cookie(request, token) });
}
export async function publicAuth(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  if (path === '/api/auth/status' && request.method === 'GET') {
    configured(env);
    const site = await getSite(env);
    return json({
      initialized: Boolean(site.password_hash),
      authenticated: Boolean(await findSession(request, env)),
      name: env.APP_NAME || '页间',
    });
  }
  if (path === '/api/auth/setup' && request.method === 'POST') {
    configured(env);
    await throttle(request, env);
    const data = await body<{ token: string; password: string }>(request);
    if (
      typeof data.token !== 'string' ||
      data.token.length > 256 ||
      !(await sameSecret(data.token, env.SETUP_TOKEN))
    )
      throw new AppError(403, '初始化链接无效，请使用部署时生成的专属链接。');
    const site = await getSite(env);
    if (site.password_hash) throw new AppError(409, '站点已初始化，请直接登录。');
    const password = validatePassword(data.password),
      salt = randomToken(16),
      hash = await passwordHash(password, salt);
    const row = await env.DB.prepare(
      'UPDATE site SET password_hash=?,password_salt=?,password_iterations=?,initialized_at=? WHERE id=1 AND password_hash IS NULL RETURNING auth_epoch',
    )
      .bind(hash, salt, PASSWORD_ITERATIONS, Date.now())
      .first<{ auth_epoch: number }>();
    if (!row) throw new AppError(409, '初始化已完成，请登录。');
    return issueSession(request, env, row.auth_epoch);
  }
  if (path === '/api/auth/login' && request.method === 'POST') {
    configured(env);
    const key = await throttle(request, env);
    const { password } = await body<{ password: string }>(request);
    textValue(password, '密码', 256);
    const site = await getSite(env);
    if (!site.password_hash || !site.password_salt)
      throw new AppError(409, '请先通过专属链接设置密码。');
    const hash = await passwordHash(password, site.password_salt, site.password_iterations);
    if (!(await sameSecret(hash, site.password_hash)))
      throw new AppError(401, '密码不正确，请重新输入。', 'INVALID_PASSWORD');
    await env.DB.prepare('DELETE FROM login_attempts WHERE key=?').bind(key).run();
    return issueSession(request, env, site.auth_epoch);
  }
  return null;
}
export async function accountAuth(
  request: Request,
  env: Env,
  session: Session,
  path: string,
): Promise<Response | null> {
  if (request.method !== 'POST') return null;
  if (path === '/api/auth/logout') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(session.token_hash).run();
    return json({ ok: true }, 200, { 'set-cookie': cookie(request, '', 0) });
  }
  if (path === '/api/auth/logout-all') {
    await env.DB.batch([
      env.DB.prepare('UPDATE site SET auth_epoch=auth_epoch+1 WHERE id=1'),
      env.DB.prepare('DELETE FROM sessions'),
    ]);
    return json({ ok: true }, 200, { 'set-cookie': cookie(request, '', 0) });
  }
  if (path === '/api/auth/password') {
    await throttle(request, env);
    const data = await body<{ currentPassword: string; newPassword: string }>(request);
    textValue(data.currentPassword, '当前密码', 256);
    const password = validatePassword(data.newPassword);
    const site = await getSite(env);
    if (
      !site.password_salt ||
      !site.password_hash ||
      !(await sameSecret(
        await passwordHash(data.currentPassword, site.password_salt, site.password_iterations),
        site.password_hash,
      ))
    )
      throw new AppError(401, '当前密码不正确。', 'INVALID_PASSWORD');
    const salt = randomToken(16),
      hash = await passwordHash(password, salt);
    const changed = await env.DB.prepare(
      'UPDATE site SET password_hash=?,password_salt=?,password_iterations=?,auth_epoch=auth_epoch+1 WHERE id=1 AND auth_epoch=? RETURNING id',
    )
      .bind(hash, salt, PASSWORD_ITERATIONS, session.epoch)
      .first();
    if (!changed) throw new AppError(409, '密码已在其他设备更新，请重新登录。');
    await env.DB.prepare('DELETE FROM sessions WHERE epoch<=?').bind(session.epoch).run();
    return json({ ok: true }, 200, { 'set-cookie': cookie(request, '', 0) });
  }
  return null;
}
async function signingKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(env.APP_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}
export async function editToken(env: Env, session: Session, scope: string): Promise<string> {
  const data = base64(
    encoder.encode(
      JSON.stringify({
        session: session.token_hash,
        scope,
        expires: Math.min(session.expires_at, Date.now() + 8 * 3600_000),
      }),
    ),
  );
  const signature = base64(
    new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(env), encoder.encode(data))),
  );
  return `${data}.${signature}`;
}
export async function requireEdit(
  request: Request,
  env: Env,
  session: Session,
  scope = 'library',
): Promise<void> {
  const token = request.headers.get(scope === 'library' ? 'x-library-edit' : 'x-note-edit');
  if (!token || token.length > 2048)
    throw new AppError(403, '请先确认进入编辑模式。', 'EDIT_LOCKED');
  try {
    const [data, signature] = token.split('.');
    if (
      !signature ||
      !(await crypto.subtle.verify(
        'HMAC',
        await signingKey(env),
        fromBase64(signature),
        encoder.encode(data),
      ))
    )
      throw new Error();
    const value = JSON.parse(new TextDecoder().decode(fromBase64(data)));
    if (
      value.session !== session.token_hash ||
      value.scope !== scope ||
      value.expires <= Date.now()
    )
      throw new Error();
  } catch {
    throw new AppError(403, '编辑确认已失效，请重新确认；当前编辑内容会保留。', 'EDIT_LOCKED');
  }
}
