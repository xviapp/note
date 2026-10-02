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
          (name) =>
            name !== '/sw.js' &&
            name !== '/_headers' &&
            name !== '/android-webview.html' &&
            !name.startsWith('/offline-resources-') &&
            !name.endsWith('.map'),
        )
        // Supported browsers use WOFF2. Do not download the unused WOFF/TTF
        // fallbacks for every Chinese subset and KaTeX font a second time.
        .filter((name) => !/^\/assets\/.*\.(?:woff|ttf)$/.test(name))
        // Cloudflare redirects /index.html to /. Replaying a redirected response
        // for a navigation whose redirect mode is manual fails in Chromium.
        .map((name) => (name === '/index.html' ? '/' : name))
        .sort();
      const version = createHash('sha256');
      const contents = new Map<string, Uint8Array>();
      for (const file of files) {
        const content = await readFile(
          path.join(output, file === '/' ? 'index.html' : file.slice(1)),
        );
        contents.set(file, content);
        version.update(file).update(content);
      }
      const hash = version.digest('hex').slice(0, 16);
      // Hundreds of small CJK subsets and PDF character maps make first-time
      // installation latency-bound. Fetch a few bounded public resource packs
      // instead, then restore their original URLs in the service-worker cache.
      const packed = new Set<string>();
      const packs: string[] = [];
      let entries: [string, string, string][] = [];
      let packedBytes = 0;
      const flushPack = async () => {
        if (!entries.length) return;
        const file = `/offline-resources-${hash}-${packs.length}.json`;
        await writeFile(path.join(output, file.slice(1)), JSON.stringify(entries));
        packs.push(file);
        entries = [];
        packedBytes = 0;
      };
      for (const [file, content] of contents) {
        if (!/\.(?:woff2|bcmap|pfb|ttf|otf|png|ico)$/.test(file)) continue;
        if (packedBytes + content.length > 2_000_000) await flushPack();
        entries.push([
          file,
          file.endsWith('.woff2')
            ? 'font/woff2'
            : file.endsWith('.png')
              ? 'image/png'
              : file.endsWith('.ico')
                ? 'image/x-icon'
                : 'application/octet-stream',
          await readFile(path.join(output, file.slice(1)), 'base64'),
        ]);
        packed.add(file);
        packedBytes += content.length;
      }
      await flushPack();
      await writeFile(
        path.join(output, 'sw.js'),
        `
const CACHE = ${JSON.stringify(`yejian-shell-${hash}`)};
const FILES = ${JSON.stringify(files)};
const CORE = ${JSON.stringify(files.filter((file) => !packed.has(file)))};
const PACKS = ${JSON.stringify(packs)};
const PUBLIC = new Set(FILES);
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const jobs = [
      ...CORE.map((url) => async () => {
        const response = await fetch(new Request(url, { cache: 'reload' }));
        if (!response.ok) throw new Error('Offline assets unavailable');
        await cache.put(url, response);
      }),
      ...PACKS.map((url) => async () => {
        const response = await fetch(new Request(url, { cache: 'no-store' }));
        if (!response.ok) throw new Error('Offline resources unavailable');
        for (const [file, type, encoded] of await response.json()) {
          const binary = atob(encoded);
          const data = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
          await cache.put(file, new Response(data, { headers: { 'Content-Type': type } }));
        }
      }),
    ];
    let index = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (index < jobs.length) await jobs[index++]();
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
  const navigation = request.mode === 'navigate' && (url.pathname === '/' || /^\\/n\\/[\\w-]+$/.test(url.pathname) || /^\\/(?:favorites|recent|offline|trash|settings(?:\\/(?:theme|reading|ai|offline|share|backup|storage|account|about))?)$/.test(url.pathname));
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
