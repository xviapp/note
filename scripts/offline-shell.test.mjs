import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { offlineShell } from './offline-shell.ts';

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yejian-offline-build-'));
  const output = path.join(root, 'dist');
  const source = new Map([
    ['index.html', Buffer.from('<title>页间</title>')],
    ['theme-init.js', Buffer.from('initial theme')],
    ['_headers', Buffer.from('/assets/*\n  Cache-Control: immutable\n')],
    ['assets/serif.woff2', Buffer.alloc(1_100_000, 0xff)],
    ['assets/sans.woff2', Buffer.alloc(1_100_000, 0x80)],
    ['assets/serif.woff', Buffer.from('unused fallback')],
    ['pdf/cmaps/example.bcmap', Buffer.from([0, 128, 255, 42])],
  ]);
  try {
    for (const [file, bytes] of source) {
      await mkdir(path.dirname(path.join(output, file)), { recursive: true });
      await writeFile(path.join(output, file), bytes);
    }
    const build = async (mode = 'production') => {
      const plugin = offlineShell();
      plugin.configResolved({ root, mode, build: { outDir: 'dist' } });
      await plugin.closeBundle();
    };
    await run({ source, output, build });
  } finally {
    await rm(root, { recursive: true });
  }
}

test('public resource packs preserve binary bytes and original cache URLs', () =>
  fixture(async ({ source, output, build }) => {
    await build();
    const worker = await readFile(path.join(output, 'sw.js'), 'utf8');
    const packs = JSON.parse(worker.match(/^const PACKS = (.+);$/m)[1]);
    const files = JSON.parse(worker.match(/^const FILES = (.+);$/m)[1]);
    const core = JSON.parse(worker.match(/^const CORE = (.+);$/m)[1]);
    assert.equal(packs.length, 2);
    assert(files.includes('/'));
    assert(!files.includes('/index.html'));
    assert(!files.includes('/_headers'));
    assert(!files.includes('/assets/serif.woff'));
    const restored = new Map();
    for (const pack of packs)
      for (const [url, type, encoded] of JSON.parse(
        await readFile(path.join(output, pack.slice(1)), 'utf8'),
      )) {
        assert(!restored.has(url));
        assert.equal(type, url.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream');
        restored.set(url, Buffer.from(encoded, 'base64'));
      }
    for (const file of files) {
      assert(core.includes(file) !== restored.has(file));
      if (restored.has(file)) assert.deepEqual(restored.get(file), source.get(file.slice(1)));
    }
    assert(restored.has('/pdf/cmaps/example.bcmap'));
    assert(restored.has('/assets/serif.woff2'));
  }));

test('unchanged builds are stable and edits to unversioned public assets invalidate the shell', () =>
  fixture(async ({ output, build }) => {
    await build();
    const original = await readFile(path.join(output, 'sw.js'), 'utf8');
    await build();
    assert.equal(await readFile(path.join(output, 'sw.js'), 'utf8'), original);
    await writeFile(path.join(output, 'theme-init.js'), 'updated theme');
    await build();
    assert.notEqual(await readFile(path.join(output, 'sw.js'), 'utf8'), original);
  }));

test('Android uses the APK assets without generating a web service worker or resource packs', () =>
  fixture(async ({ output, build }) => {
    await build('android');
    const files = await readdir(output);
    assert(!files.includes('sw.js'));
    assert(!files.some((file) => file.startsWith('offline-resources-')));
  }));

test('collection and settings deep links reopen offline without caching API requests', () =>
  fixture(async ({ output, build }) => {
    await build();
    const handlers = new Map();
    const shell = { body: 'offline application shell' };
    runInNewContext(await readFile(path.join(output, 'sw.js'), 'utf8'), {
      URL,
      self: {
        location: { origin: 'https://note.test' },
        addEventListener: (name, callback) => handlers.set(name, callback),
      },
      fetch: async () => {
        throw new Error('offline');
      },
      caches: { open: async () => ({ match: async (path) => (path === '/' ? shell : undefined) }) },
    });
    for (const path of [
      '/',
      '/n/abc',
      '/favorites',
      '/recent',
      '/offline',
      '/trash',
      '/settings',
      '/settings/theme',
      '/settings/reading',
      '/settings/ai',
      '/settings/offline',
      '/settings/share',
      '/settings/backup',
      '/settings/storage',
      '/settings/account',
      '/settings/about',
      '/settings/proxy',
    ]) {
      let response;
      handlers.get('fetch')({
        request: { method: 'GET', mode: 'navigate', url: `https://note.test${path}` },
        respondWith: (promise) => {
          response = promise;
        },
      });
      assert.equal(await response, shell, path);
    }
    for (const path of ['/api/nodes', '/settings/unknown', '/unknown']) {
      handlers.get('fetch')({
        request: { method: 'GET', mode: 'navigate', url: `https://note.test${path}` },
        respondWith: () => assert.fail(`Unexpected offline handler: ${path}`),
      });
    }
  }));
