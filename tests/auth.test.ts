/// <reference types="@cloudflare/vitest-pool-workers/types" />
import {
  env,
  SELF,
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker/index';
import { passwordHash, PASSWORD_ITERATIONS } from '../worker/auth';
import type { Env } from '../worker/types';
import { preparePassword, type PasswordProof } from '../shared/password';
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
  it('sets up, logs in and changes password when server PBKDF2 is unavailable', async () => {
    const original = (await preparePassword('Note2026')) as PasswordProof;
    const replacement = (await preparePassword('Next2026')) as PasswordProof;
    const short = (await preparePassword('1234567')) as PasswordProof;
    const derive = vi
      .spyOn(crypto.subtle, 'deriveBits')
      .mockRejectedValue(
        new DOMException(
          'Pbkdf2 iteration counts above 100000 are not supported',
          'NotSupportedError',
        ),
      );
    const context = createExecutionContext();
    const send = (path: string, data: unknown, cookie = '') =>
      worker.fetch(
        new Request(`https://notes.test${path}`, {
          method: 'POST',
          headers: { origin: 'https://notes.test', 'content-type': 'application/json', cookie },
          body: JSON.stringify(data),
        }),
        bindings,
        context,
      );
    try {
      expect(
        (await send('/api/auth/setup', { token: bindings.SETUP_TOKEN, password: short })).status,
      ).toBe(400);
      const setup = await send('/api/auth/setup', {
        token: bindings.SETUP_TOKEN,
        password: original,
      });
      expect(setup.status, await setup.clone().text()).toBe(200);
      const firstCookie = setup.headers.get('set-cookie')!.split(';')[0];
      const stored = await bindings.DB.prepare('SELECT password_hash FROM site WHERE id=1').first<{
        password_hash: string;
      }>();
      expect(stored!.password_hash).not.toContain(original.derived);
      const stolen = { ...original, derived: stored!.password_hash.split(':').at(-1) };
      expect((await send('/api/auth/login', { password: stolen })).status).toBe(401);
      expect(
        (await send('/api/auth/login', { password: { ...original, iterations: 100_000 } })).status,
      ).toBe(401);
      const login = await send('/api/auth/login', { password: original });
      expect(login.status).toBe(200);
      const changed = await send(
        '/api/auth/password',
        { currentPassword: original, newPassword: replacement },
        firstCookie,
      );
      expect(changed.status, await changed.clone().text()).toBe(200);
      expect((await request('/api/auth/status', undefined, firstCookie)).status).toBe(200);
      expect(
        await (await request('/api/auth/status', undefined, firstCookie)).json(),
      ).toMatchObject({
        authenticated: false,
        password: { clientHash: true, salt: replacement.salt, iterations: PASSWORD_ITERATIONS },
      });
      expect((await send('/api/auth/login', { password: original })).status).toBe(401);
      expect((await send('/api/auth/login', { password: replacement })).status).toBe(200);
      expect(derive).not.toHaveBeenCalled();
    } finally {
      derive.mockRestore();
      await waitOnExecutionContext(context);
    }
  });

  it('accepts eight-character passwords and rejects seven for setup and changes', async () => {
    const shortSetup = await request('/api/auth/setup', {
      token: bindings.SETUP_TOKEN,
      password: '1234567',
    });
    expect(shortSetup.status).toBe(400);
    expect(await shortSetup.text()).toContain('8 个字符');
    const setup = await request('/api/auth/setup', {
      token: bindings.SETUP_TOKEN,
      password: '12345678',
    });
    expect(setup.status).toBe(200);
    const cookie = setup.headers.get('set-cookie')!.split(';')[0];
    const shortChange = await request(
      '/api/auth/password',
      {
        currentPassword: '12345678',
        newPassword: '1234567',
      },
      cookie,
    );
    expect(shortChange.status).toBe(400);
    const changed = await request(
      '/api/auth/password',
      {
        currentPassword: '12345678',
        newPassword: '87654321',
      },
      cookie,
    );
    expect(changed.status).toBe(200);
    expect((await request('/api/auth/login', { password: '87654321' })).status).toBe(200);
  });

  it('upgrades an existing local password without accepting its stored hash as a proof', async () => {
    const salt = 'YWJjZGVmZ2hpamtsbW5vcA';
    const hash = await passwordHash('legacy-password', salt);
    await bindings.DB.prepare(
      'UPDATE site SET password_hash=?,password_salt=?,password_iterations=? WHERE id=1',
    )
      .bind(hash, salt, PASSWORD_ITERATIONS)
      .run();
    const proof = await preparePassword('legacy-password', {
      salt,
      iterations: PASSWORD_ITERATIONS,
      clientHash: true,
    });
    expect((await request('/api/auth/login', { password: proof })).status).toBe(401);
    expect((await request('/api/auth/login', { password: 'legacy-password' })).status).toBe(200);
    const stored = await bindings.DB.prepare(
      'SELECT password_hash,password_salt FROM site WHERE id=1',
    ).first<{ password_hash: string; password_salt: string }>();
    expect(stored!.password_hash).toMatch(/^hmac-v1:/);
    expect(stored!.password_hash).not.toContain(hash);
    expect(stored!.password_salt).toBe(salt);
    expect((await request('/api/auth/login', { password: proof })).status).toBe(200);
  });

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
  it('counts only failed sign-ins and keeps known devices clear of the site-wide limit', async () => {
    await request('/api/auth/setup', {
      token: bindings.SETUP_TOKEN,
      password: 'a-long-password-for-testing',
    });
    // Successful sign-ins give their attempt back, so they never add up to a lockout.
    for (let attempt = 0; attempt < 12; attempt++)
      expect(
        (await request('/api/auth/login', { password: 'a-long-password-for-testing' })).status,
      ).toBe(200);
    const login = await request('/api/auth/login', { password: 'a-long-password-for-testing' });
    const device = login.headers
      .getSetCookie()
      .find((value) => value.startsWith('note_device='))!
      .split(';')[0];
    expect(device).toMatch(/^note_device=[\w-]+\.[\w-]+$/);
    // Simulate guesses from many addresses filling the site-wide window.
    await bindings.DB.prepare(
      "INSERT OR REPLACE INTO login_attempts(key,attempts,window_start) VALUES('global',100,?)",
    )
      .bind(Date.now())
      .run();
    expect(
      (await request('/api/auth/login', { password: 'a-long-password-for-testing' })).status,
    ).toBe(429);
    expect(
      (await request('/api/auth/login', { password: 'a-long-password-for-testing' }, device))
        .status,
    ).toBe(200);
    // A forged or outdated device mark gets no exemption.
    expect(
      (
        await request(
          '/api/auth/login',
          { password: 'a-long-password-for-testing' },
          device.replace(/\.[\w-]+$/, '.forged'),
        )
      ).status,
    ).toBe(429);
    await bindings.DB.prepare('UPDATE site SET auth_epoch=auth_epoch+1 WHERE id=1').run();
    expect(
      (await request('/api/auth/login', { password: 'a-long-password-for-testing' }, device))
        .status,
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
    const create = await SELF.fetch('https://notes.test/api/nodes', {
      method: 'POST',
      headers: {
        origin: 'https://notes.test',
        cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'markdown',
        title: '重置后保留',
        content: '原来保存的正文',
      }),
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
    const rotated = {
      ...bindings,
      SETUP_TOKEN: 'rotated-test-only-secret-for-deployment-reset',
    };
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
