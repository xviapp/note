/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, SELF, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../worker/types';
import { cleanup } from '../worker/recovery';
import { preparePassword } from '../shared/password';

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const ORIGIN = 'https://notes.test';
let cookie = '';
const call = (
  path: string,
  method = 'GET',
  data?: unknown,
  auth: { cookie?: string; token?: string } = { cookie },
) =>
  SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      'x-idempotency-key': crypto.randomUUID(),
      ...(auth.cookie ? { cookie: auth.cookie } : {}),
      ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
const mint = async (scope: string) =>
  ((await (await call('/api/tokens', 'POST', { name: '电脑', scope })).json()) as { token: string }).token;
beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await bindings.DB.batch([
    bindings.DB.prepare('DELETE FROM api_tokens'),
    bindings.DB.prepare('DELETE FROM sessions'),
    bindings.DB.prepare('DELETE FROM login_attempts'),
    bindings.DB.prepare('UPDATE site SET password_hash=NULL,password_salt=NULL,auth_epoch=0 WHERE id=1'),
  ]);
  const setup = await SELF.fetch(`${ORIGIN}/api/auth/setup`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({
      token: bindings.SETUP_TOKEN,
      password: await preparePassword('a-long-password-for-testing'),
    }),
  });
  cookie = setup.headers.get('set-cookie')!.split(';')[0];
});
describe('api tokens', () => {
  it('reads with a read token and refuses writes', async () => {
    const token = await mint('read');
    expect((await call('/api/nodes', 'GET', undefined, { token })).status).toBe(200);
    const write = await call('/api/nodes', 'POST', { kind: 'folder', title: 'x' }, { token });
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ code: 'TOKEN_SCOPE' });
  });
  it('edits notes with a write token, through the edit check', async () => {
    const token = await mint('write');
    const node = (await (
      await call('/api/nodes', 'POST', { kind: 'markdown', title: 'n', content: '一' }, { token })
    ).json()) as { id: string; revision: number };
    const save = (edit?: string) =>
      SELF.fetch(`${ORIGIN}/api/nodes/${node.id}/content`, {
        method: 'PUT',
        headers: {
          origin: ORIGIN,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-idempotency-key': crypto.randomUUID(),
          ...(edit ? { 'x-note-edit': edit } : {}),
        },
        body: JSON.stringify({ content: '二', revision: node.revision, attachments: [] }),
      });
    expect((await save()).status).toBe(403);
    const unlock = (await (
      await call('/api/edit/unlock', 'POST', { nodeId: node.id }, { token })
    ).json()) as { token: string };
    expect((await save(unlock.token)).status).toBe(200);
    expect((await call(`/api/nodes/${node.id}`, 'DELETE', { count: 1 }, { token })).status).toBe(200);
  });
  it.each([
    ['/api/tokens', 'GET'],
    ['/api/tokens', 'POST'],
    ['/api/backups', 'POST'],
    ['/api/auth/password', 'POST'],
    ['/api/auth/logout-all', 'POST'],
    ['/api/ai/settings', 'GET'],
    ['/api/encryption/keys', 'POST'],
    ['/api/trash/abc', 'DELETE'],
    ['/api/clips', 'GET'],
    ['/api/nodes/abc/encryption', 'PUT'],
    ['/api/nodes/abc/versions/v/restore', 'POST'],
  ])('keeps %s %s from every token', async (path, method) => {
    const token = await mint('write');
    const response = await call(path, method, method === 'GET' ? undefined : {}, { token });
    expect(response.status).toBe(403);
  });
  it('does not treat a browser session as limited, or a bad token as anything', async () => {
    expect((await call('/api/tokens')).status).toBe(200);
    expect((await call('/api/nodes', 'GET', undefined, { token: 'xvi_wrong' })).status).toBe(401);
    // A bad bearer does not fall back to a cookie sent with it.
    const both = await SELF.fetch(`${ORIGIN}/api/nodes`, {
      headers: { cookie, authorization: 'Bearer xvi_wrong' },
    });
    expect(both.status).toBe(401);
  });
  it('stores only a hash, lists without secrets and revokes', async () => {
    const token = await mint('read');
    const stored = await bindings.DB.prepare('SELECT token_hash FROM api_tokens').first<{ token_hash: string }>();
    expect(stored!.token_hash).not.toContain(token);
    const { tokens } = (await (await call('/api/tokens')).json()) as { tokens: Record<string, unknown>[] };
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).not.toHaveProperty('token_hash');
    expect((await call(`/api/tokens/${tokens[0].id}`, 'DELETE')).status).toBe(200);
    expect((await call('/api/nodes', 'GET', undefined, { token })).status).toBe(401);
  });
  it('lets a token revoke itself', async () => {
    const token = await mint('read');
    expect((await call('/api/tokens/current', 'DELETE', undefined, { token })).status).toBe(200);
    expect((await call('/api/nodes', 'GET', undefined, { token })).status).toBe(401);
  });
  it('records use', async () => {
    const token = await mint('read');
    await call('/api/nodes', 'GET', undefined, { token });
    const row = await bindings.DB.prepare('SELECT last_used_at FROM api_tokens').first<{ last_used_at: number }>();
    expect(row!.last_used_at).toBeGreaterThan(0);
  });
  it('ends when every device is signed out, and cleanup removes it', async () => {
    const token = await mint('write');
    expect((await call('/api/auth/logout-all', 'POST', {})).status).toBe(200);
    expect((await call('/api/nodes', 'GET', undefined, { token })).status).toBe(401);
    await cleanup(bindings, { files: false });
    expect(await bindings.DB.prepare('SELECT COUNT(*) n FROM api_tokens').first('n')).toBe(0);
  });
  it('limits how many exist', async () => {
    for (let i = 0; i < 20; i++) await mint('read');
    expect((await call('/api/tokens', 'POST', { name: 'x', scope: 'read' })).status).toBe(409);
  });
  it('rejects an unknown scope', async () => {
    expect((await call('/api/tokens', 'POST', { name: 'x', scope: 'admin' })).status).toBe(400);
  });
});
