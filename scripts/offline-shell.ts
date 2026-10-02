import type { Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Only public, build-owned assets enter this cache. Auth, documents, and files
// keep their no-store headers and are handled explicitly by offline-cache.ts.
export function offlineShell(): Plugin {
  let output: string;
  let enabled = false;
  return {
    name: 'yejian-offline-shell',
    apply: 'build',
    configResolved(config) {
      output = path.resolve(config.root, config.build.outDir);
      enabled = config.mode !== 'android';
    },
    async closeBundle() {
      if (!enabled) return;
      const files = (await readdir(output, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map(
          (entry) =>
            '/' +
            path
              .relative(output, path.join(entry.parentPath, entry.name))
              .split(path.sep)
              .join('/'),
        )
        .filter(
          (name) => name !== '/sw.js' && name !== '/android-webview.html' && !name.endsWith('.map'),
        )
        // Cloudflare redirects /index.html to /. Replaying a redirected response
        // for a navigation whose redirect mode is manual fails in Chromium.
        .map((name) => (name === '/index.html' ? '/' : name))
        .sort();
      const hash = createHash('sha256')
        .update(JSON.stringify(files))
        .update(await readFile(path.join(output, 'index.html')))
        .digest('hex')
        .slice(0, 16);
      await writeFile(
        path.join(output, 'sw.js'),
        `
const CACHE = ${JSON.stringify(`yejian-shell-${hash}`)};
const FILES = ${JSON.stringify(files)};
const PUBLIC = new Set(FILES);
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    let index = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (index < FILES.length) {
        const url = FILES[index++];
        const response = await fetch(new Request(url, { cache: 'reload' }));
        if (!response.ok) throw new Error('Offline assets unavailable');
        await cache.put(url, response);
      }
    }));
  })());
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys())
      if (key.startsWith('yejian-shell-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (event) => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const navigation = request.mode === 'navigate' && (url.pathname === '/' || /^\\/n\\/[\\w-]+$/.test(url.pathname));
  if (navigation) {
    event.respondWith(fetch(request).catch(async () => {
      const response = await (await caches.open(CACHE)).match('/');
      return response || Response.error();
    }));
  } else if (PUBLIC.has(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      return await cache.match(url.pathname) || fetch(request);
    })());
  }
});
`,
      );
    },
  };
}
