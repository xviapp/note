import type { Env, Session, Site } from './types';
import { AppError, body, json, textValue } from './http';
import {
  MIN_PASSWORD_LENGTH,
  PASSWORD_ITERATIONS,
  derivePasswordHash,
  type PasswordProof,
} from '../shared/password';

const encoder = new TextEncoder();
export { PASSWORD_ITERATIONS } from '../shared/password';
const PASSWORD_PREFIX = 'hmac-v1:';
const SESSION_MS = 30 * 86400_000;
export const COOKIE = 'note_session';
// Marks a browser that has signed in before; it only exempts that browser from
// the site-wide login limit, so others guessing passwords cannot lock it out.
const DEVICE_COOKIE = 'note_device';
const DEVICE_MS = 365 * 86400_000;
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
  return derivePasswordHash(password, salt, iterations);
}
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}
async function passwordProof(input: unknown, site?: Site): Promise<PasswordProof> {
  let proof: PasswordProof;
  if (typeof input === 'string') {
    // Backwards compatibility for existing local accounts and older API clients.
    // Cloudflare's hosted runtime requires the browser-prepared proof instead.
    const password = textValue(input, '密码', 256);
    if (!site && [...password].length < MIN_PASSWORD_LENGTH)
      throw new AppError(400, `密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符。`);
    const salt = site?.password_salt ?? randomToken(16);
    const iterations = site?.password_iterations ?? PASSWORD_ITERATIONS;
    let derived: string;
    try {
      derived = await passwordHash(password, salt, iterations);
    } catch (error) {
      if (error instanceof Error && error.name === 'NotSupportedError')
        throw new AppError(
          400,
          '请刷新页面后重试；旧版客户端不支持云端密码校验。',
          'PASSWORD_CLIENT_OUTDATED',
        );
      throw error;
    }
    proof = { derived, salt, iterations, length: [...password].length };
  } else {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new AppError(400, '密码校验数据无效。');
    proof = input as PasswordProof;
    if (
      typeof proof.derived !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(proof.derived) ||
      typeof proof.salt !== 'string' ||
      !/^[A-Za-z0-9_-]{22}$/.test(proof.salt) ||
      base64(fromBase64(proof.derived)) !== proof.derived ||
      base64(fromBase64(proof.salt)) !== proof.salt ||
      !Number.isSafeInteger(proof.iterations) ||
      proof.iterations < 1 ||
      proof.iterations > PASSWORD_ITERATIONS ||
      !Number.isSafeInteger(proof.length) ||
      proof.length < 1 ||
      proof.length > 256
    )
      throw new AppError(400, '密码校验数据无效。');
  }
  if (!site && proof.length < MIN_PASSWORD_LENGTH)
    throw new AppError(400, `密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符。`);
  if (!site && proof.iterations !== PASSWORD_ITERATIONS)
    throw new AppError(400, '密码计算强度不正确，请刷新页面后重试。');
  if (site && (proof.salt !== site.password_salt || proof.iterations !== site.password_iterations))
    throw new AppError(401, '密码不正确，请重新输入。', 'INVALID_PASSWORD');
  return proof;
}
async function sealPassword(env: Env, proof: PasswordProof): Promise<string> {
  const value = JSON.stringify(['password-v1', proof.salt, proof.iterations, proof.derived]);
  return (
    PASSWORD_PREFIX +
    base64(
      new Uint8Array(
        await crypto.subtle.sign('HMAC', await signingKey(env), encoder.encode(value)),
      ),
    )
  );
}
async function verifyPassword(env: Env, site: Site, input: unknown): Promise<PasswordProof | null> {
  if (!site.password_hash || !site.password_salt) return null;
  const sealed = site.password_hash.startsWith(PASSWORD_PREFIX);
  // A legacy PBKDF2 database value must never be accepted as a login proof.
  if (!sealed && typeof input !== 'string') return null;
  const proof = await passwordProof(input, site);
  const hash = sealed ? await sealPassword(env, proof) : proof.derived;
  return (await sameSecret(hash, site.password_hash)) ? proof : null;
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
function cookie(
  request: Request,
  token: string,
  maxAge = SESSION_MS / 1000,
  name = COOKIE,
  path = '/',
): string {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname);
  return `${name}=${token}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${local && new URL(request.url).protocol === 'http:' ? '' : '; Secure'}`;
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
async function knownDevice(request: Request, env: Env, epoch: number): Promise<boolean> {
  const value = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${DEVICE_COOKIE}=`))
    ?.slice(DEVICE_COOKIE.length + 1);
  const [id, signature] = value?.split('.') ?? [];
  if (!id || !signature || !/^[A-Za-z0-9_-]{22,64}$/.test(id)) return false;
  return sameSecret(signature, await deviceSignature(env, id, epoch));
}
async function deviceSignature(env: Env, id: string, epoch: number): Promise<string> {
  return base64(
    new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        await signingKey(env),
        encoder.encode(JSON.stringify(['device-v1', id, epoch])),
      ),
    ),
  );
}
// Attempts are counted before the password is checked, so concurrent guesses
// cannot slip past the limit; a successful sign-in gives its attempt back.
async function throttle(request: Request, env: Env): Promise<{ key: string; known: boolean }> {
  const key = await digest(
    `${env.APP_SECRET}:${request.headers.get('cf-connecting-ip') ?? 'local'}`,
  );
  const site = await getSite(env);
  const known = await knownDevice(request, env, site.auth_epoch);
  const now = Date.now(),
    window = 60_000;
  const count = (id: string) =>
    env.DB.prepare(
      'INSERT INTO login_attempts(key,attempts,window_start) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start<? THEN 1 ELSE attempts+1 END, window_start=CASE WHEN window_start<? THEN excluded.window_start ELSE window_start END RETURNING attempts',
    ).bind(id, now, now - window, now - window);
  const rows = await env.DB.batch<{ attempts: number }>(
    known ? [count(key)] : [count(key), count('global')],
  );
  if (
    Number(rows[0].results[0]?.attempts) > 8 ||
    (!known && Number(rows[1].results[0]?.attempts) > 40)
  )
    throw new AppError(429, '尝试过于频繁，请一分钟后再试。', 'RATE_LIMITED');
  return { key, known };
}
async function forgiveAttempt(env: Env, attempt: { key: string; known: boolean }) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM login_attempts WHERE key=?').bind(attempt.key),
    ...(attempt.known
      ? []
      : [
          env.DB.prepare(
            "UPDATE login_attempts SET attempts=attempts-1 WHERE key='global' AND attempts>0",
          ),
        ]),
  ]);
}
async function issueSession(request: Request, env: Env, epoch: number): Promise<Response> {
  const token = randomToken(),
    now = Date.now();
  await env.DB.prepare(
    'INSERT INTO sessions(token_hash,epoch,created_at,expires_at) VALUES(?,?,?,?)',
  )
    .bind(await digest(token), epoch, now, now + SESSION_MS)
    .run();
  const response = json({ ok: true }, 200, { 'set-cookie': cookie(request, token) });
  const device = randomToken(16);
  response.headers.append(
    'set-cookie',
    cookie(
      request,
      `${device}.${await deviceSignature(env, device, epoch)}`,
      DEVICE_MS / 1000,
      DEVICE_COOKIE,
      '/api/auth/',
    ),
  );
  return response;
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
      ...(site.password_salt
        ? {
            password: {
              salt: site.password_salt,
              iterations: site.password_iterations,
              clientHash: Boolean(site.password_hash?.startsWith(PASSWORD_PREFIX)),
            },
          }
        : {}),
    });
  }
  if (path === '/api/auth/setup' && request.method === 'POST') {
    configured(env);
    const attempt = await throttle(request, env);
    const data = await body<{ token: string; password: unknown }>(request);
    if (
      typeof data.token !== 'string' ||
      data.token.length > 256 ||
      !(await sameSecret(data.token, env.SETUP_TOKEN))
    )
      throw new AppError(403, '初始化链接无效，请使用部署时生成的专属链接。');
    const site = await getSite(env);
    if (site.password_hash) throw new AppError(409, '站点已初始化，请直接登录。');
    const proof = await passwordProof(data.password),
      hash = await sealPassword(env, proof);
    const row = await env.DB.prepare(
      'UPDATE site SET password_hash=?,password_salt=?,password_iterations=?,initialized_at=? WHERE id=1 AND password_hash IS NULL RETURNING auth_epoch',
    )
      .bind(hash, proof.salt, proof.iterations, Date.now())
      .first<{ auth_epoch: number }>();
    if (!row) throw new AppError(409, '初始化已完成，请登录。');
    await forgiveAttempt(env, attempt);
    return issueSession(request, env, row.auth_epoch);
  }
  if (path === '/api/auth/login' && request.method === 'POST') {
    configured(env);
    const attempt = await throttle(request, env);
    const { password } = await body<{ password: unknown }>(request);
    const site = await getSite(env);
    if (!site.password_hash || !site.password_salt)
      throw new AppError(409, '请先通过专属链接设置密码。');
    const proof = await verifyPassword(env, site, password);
    if (!proof) throw new AppError(401, '密码不正确，请重新输入。', 'INVALID_PASSWORD');
    if (!site.password_hash.startsWith(PASSWORD_PREFIX)) {
      const upgraded = await env.DB.prepare(
        'UPDATE site SET password_hash=? WHERE id=1 AND password_hash=? AND auth_epoch=? RETURNING id',
      )
        .bind(await sealPassword(env, proof), site.password_hash, site.auth_epoch)
        .first();
      if (!upgraded) throw new AppError(409, '密码已更新，请重新登录。');
    }
    await forgiveAttempt(env, attempt);
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
    const attempt = await throttle(request, env);
    const data = await body<{ currentPassword: unknown; newPassword: unknown }>(request);
    const proof = await passwordProof(data.newPassword);
    const site = await getSite(env);
    if (!(await verifyPassword(env, site, data.currentPassword)))
      throw new AppError(401, '当前密码不正确。', 'INVALID_PASSWORD');
    const hash = await sealPassword(env, proof);
    const changed = await env.DB.prepare(
      'UPDATE site SET password_hash=?,password_salt=?,password_iterations=?,auth_epoch=auth_epoch+1 WHERE id=1 AND auth_epoch=? RETURNING id',
    )
      .bind(hash, proof.salt, proof.iterations, session.epoch)
      .first();
    if (!changed) throw new AppError(409, '密码已在其他设备更新，请重新登录。');
    await env.DB.prepare('DELETE FROM sessions WHERE epoch<=?').bind(session.epoch).run();
    await forgiveAttempt(env, attempt);
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
export async function editToken(env: Env, session: Session, nodeId: string): Promise<string> {
  const data = base64(
    encoder.encode(
      JSON.stringify({
        session: session.token_hash,
        scope: `note:${nodeId}`,
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
  nodeId: string,
): Promise<void> {
  const token = request.headers.get('x-note-edit');
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
      value.scope !== `note:${nodeId}` ||
      value.expires <= Date.now()
    )
      throw new Error();
  } catch {
    throw new AppError(403, '编辑确认已失效，请重新确认；当前编辑内容会保留。', 'EDIT_LOCKED');
  }
}
