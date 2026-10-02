/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, SELF, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import type { Env } from '../worker/types';
import { releasePath, validRelease } from '../shared/release';
const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
let cookie = '';
beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
  const response = await SELF.fetch('https://notes.test/api/auth/setup', {
    method: 'POST',
    headers: {
      origin: 'https://notes.test',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ token: bindings.SETUP_TOKEN, password: 'Release2026' }),
  });
  cookie = response.headers.get('set-cookie')!.split(';')[0];
});
it('keeps release metadata and APK private, serves immutable version and handles missing releases', async () => {
  const request = (path: string, authenticated = true, method = 'GET') =>
    SELF.fetch(`https://notes.test${path}`, { method, headers: authenticated ? { cookie } : {} });
  expect((await request('/api/app/android-release', false)).status).toBe(401);
  expect(await (await request('/api/app/android-release')).json()).toEqual({ release: null });
  const release = {
    version: '0.3.0',
    build: 7,
    size: 3,
    sha256: 'a'.repeat(64),
    certificate: 'b'.repeat(64),
    publishedAt: new Date().toISOString(),
    notes: '更新说明',
  };
  await bindings.FILES.put('releases/android/latest.json', JSON.stringify(release));
  await bindings.FILES.put(`releases/android/7/${release.sha256}.apk`, new Uint8Array([1, 2, 3]));
  expect(await (await request('/api/app/android-release')).json()).toEqual({ release });
  expect((await request(releasePath(release), false)).status).toBe(401);
  const download = await request(releasePath(release));
  expect([...new Uint8Array(await download.arrayBuffer())]).toEqual([1, 2, 3]);
  expect(download.headers.get('cache-control')).toContain('no-store');
  const head = await request(releasePath(release), true, 'HEAD');
  expect(head.headers.get('content-length')).toBe('3');
  expect(await head.text()).toBe('');
  expect((await request('/api/app/android-release/7/invalid.apk')).status).toBe(404);
  expect(validRelease({ ...release, size: -1 })).toBe(false);
  await bindings.FILES.put(
    'releases/android/latest.json',
    JSON.stringify({ ...release, sha256: '../oops' }),
  );
  expect((await request('/api/app/android-release')).status).toBe(502);
});
