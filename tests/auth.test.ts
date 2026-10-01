/// <reference types="@cloudflare/vitest-pool-workers/types" />
import {
  env,
  SELF,
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../worker/index';
import { passwordHash, PASSWORD_ITERATIONS } from '../worker/auth';
import type { Env } from '../worker/types';
const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await bindings.DB.batch([
    bindings.DB.prepare('DELETE FROM sessions'),
    bindings.DB.prepare('DELETE FROM login_attempts'),
    bindings.DB.prepare(
      'UPDATE site SET password_hash=NULL,password_salt=NULL,auth_epoch=0 WHERE id=1',
    ),
  ]);
});
const request = (path: string, data?: unknown, cookie?: string) =>
  SELF.fetch(`https://notes.test${path}`, {
    method: data ? 'POST' : 'GET',
    headers: {
      origin: 'https://notes.test',
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
describe('password authentication in workerd', () => {
  it('supports the approved PBKDF2 parameters and rejects another password', async () => {
    const start = performance.now();
    const hash = await passwordHash(
      'a-long-password-for-testing',
      'YWJjZGVmZ2hpamtsbW5vcA',
      PASSWORD_ITERATIONS,
    );
    console.info(
      `PBKDF2 ${PASSWORD_ITERATIONS} iterations local wall time: ${Math.round(performance.now() - start)}ms (not remote CPU)`,
    );
    expect(hash).toHaveLength(43);
    expect(await passwordHash('another-password-for-testing', 'YWJjZGVmZ2hpamtsbW5vcA')).not.toBe(
      hash,
    );
  });
  it('initializes once, logs in and revokes all sessions', async () => {
    expect(
      (
        await request('/api/auth/setup', {
          token: 'wrong',
          password: 'a-long-password-for-testing',
        })
      ).status,
    ).toBe(403);
    const setup = await request('/api/auth/setup', {
      token: bindings.SETUP_TOKEN,
      password: 'a-long-password-for-testing',
    });
    expect(setup.status, await setup.clone().text()).toBe(200);
    const first = setup.headers.get('set-cookie')!.split(';')[0];
    expect(
      (
        await request('/api/auth/setup', {
          token: bindings.SETUP_TOKEN,
          password: 'a-long-password-for-testing',
        })
      ).status,
    ).toBe(409);
    const login = await request('/api/auth/login', { password: 'a-long-password-for-testing' });
    expect(login.status, await login.clone().text()).toBe(200);
    const second = login.headers.get('set-cookie')!.split(';')[0];
    expect(await (await request('/api/auth/status', undefined, first)).json()).toMatchObject({
      authenticated: true,
    });
    expect((await request('/api/auth/logout-all', {}, first)).status).toBe(200);
    expect(await (await request('/api/auth/status', undefined, second)).json()).toMatchObject({
      authenticated: false,
    });
  });
  it('allows only one concurrent initialization and limits repeated password guesses', async () => {
    const results = await Promise.all(
      [1, 2].map(() =>
        request('/api/auth/setup', {
          token: bindings.SETUP_TOKEN,
          password: 'a-long-password-for-testing',
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    await bindings.DB.prepare('DELETE FROM login_attempts').run();
    for (let attempt = 0; attempt < 8; attempt++)
      expect((await request('/api/auth/login', { password: 'wrong-password-guess' })).status).toBe(
        401,
      );
    expect(
      (await request('/api/auth/login', { password: 'a-long-password-for-testing' })).status,
    ).toBe(429);
  });
  it('requires the old password and invalidates all sessions on password change', async () => {
    const setup = await request('/api/auth/setup', {
      token: bindings.SETUP_TOKEN,
      password: 'a-long-password-for-testing',
    });
    const first = setup.headers.get('set-cookie')!.split(';')[0];
    const login = await request('/api/auth/login', { password: 'a-long-password-for-testing' }),
      second = login.headers.get('set-cookie')!.split(';')[0];
    expect(
      (
        await request(
          '/api/auth/password',
          { currentPassword: 'wrong-password', newPassword: 'a-new-long-password-for-testing' },
          first,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await request(
          '/api/auth/password',
          {
            currentPassword: 'a-long-password-for-testing',
            newPassword: 'a-new-long-password-for-testing',
          },
          first,
        )
      ).status,
    ).toBe(200);
    for (const session of [first, second])
      expect(await (await request('/api/auth/status', undefined, session)).json()).toMatchObject({
        authenticated: false,
      });
    expect(
      (await request('/api/auth/login', { password: 'a-long-password-for-testing' })).status,
    ).toBe(401);
    expect(
      (await request('/api/auth/login', { password: 'a-new-long-password-for-testing' })).status,
    ).toBe(200);
  });
  it('fails closed during a deployment reset and retains existing library data', async () => {
    const setup = await request('/api/auth/setup', {
      token: bindings.SETUP_TOKEN,
      password: 'a-long-password-for-testing',
    });
    const cookie = setup.headers.get('set-cookie')!.split(';')[0];
    const token = (
      (await (await request('/api/edit/unlock', {}, cookie)).json()) as { token: string }
    ).token;
    const create = await SELF.fetch('https://notes.test/api/nodes', {
      method: 'POST',
      headers: {
        origin: 'https://notes.test',
        cookie,
        'x-library-edit': token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'markdown', title: '重置后保留', content: '原来保存的正文' }),
    });
    expect(create.status).toBe(201);
    const node = (await create.json()) as { id: string };
    await bindings.DB.batch([
      bindings.DB.prepare(
        "UPDATE site SET password_hash='!reset-in-progress',password_salt=NULL,auth_epoch=auth_epoch+1 WHERE id=1",
      ),
      bindings.DB.prepare('DELETE FROM sessions'),
    ]);
    expect(
      (await request('/api/auth/login', { password: 'a-long-password-for-testing' })).status,
    ).toBe(409);
    expect(
      (
        await request('/api/auth/setup', {
          token: bindings.SETUP_TOKEN,
          password: 'another-long-password',
        })
      ).status,
    ).toBe(409);
    expect((await request(`/api/nodes/${node.id}`, undefined, cookie)).status).toBe(401);
    const rotated = { ...bindings, SETUP_TOKEN: 'rotated-test-only-secret-for-deployment-reset' };
    await bindings.DB.prepare(
      'UPDATE site SET password_hash=NULL,password_salt=NULL,initialized_at=NULL WHERE id=1',
    ).run();
    const context = createExecutionContext();
    const resetRequest = (data: unknown) =>
      new Request('https://notes.test/api/auth/setup', {
        method: 'POST',
        headers: { origin: 'https://notes.test', 'content-type': 'application/json' },
        body: JSON.stringify(data),
      });
    const wrong = await worker.fetch(
      resetRequest({ token: bindings.SETUP_TOKEN, password: 'another-long-password' }),
      rotated,
      context,
    );
    expect(wrong.status).toBe(403);
    const reset = await worker.fetch(
      resetRequest({ token: rotated.SETUP_TOKEN, password: 'another-long-password' }),
      rotated,
      context,
    );
    expect(reset.status).toBe(200);
    const newCookie = reset.headers.get('set-cookie')!.split(';')[0];
    expect(
      await (await request(`/api/nodes/${node.id}`, undefined, newCookie)).json(),
    ).toMatchObject({ title: '重置后保留', content: '原来保存的正文' });
    await waitOnExecutionContext(context);
  });
});
