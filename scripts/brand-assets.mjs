import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Packaging only: the supplied artwork is kept in assets/brand. Generated
// assets are committed so ordinary builds do not need ImageMagick or Potrace.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'public/brand');
const native = path.join(root, 'android/app/src/main/res');
const temporary = path.join(root, '.wrangler/brand');
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} failed`);
};
await mkdir(output, { recursive: true });
await mkdir(temporary, { recursive: true });
for (const variant of ['day', 'night']) {
  const source = path.join(root, `assets/brand/${variant}-original.png`);
  for (const size of [64, 128, 180, 192, 512])
    run('magick', [
      source,
      '-resize',
      `${size}x${size}`,
      '-strip',
      path.join(output, `${variant}-${size}.png`),
    ]);
  const manifest = {
    id: '/',
    name: '页间',
    short_name: '页间',
    lang: 'zh-CN',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: variant === 'day' ? '#fcfdfb' : '#202824',
    theme_color: variant === 'day' ? '#fcfdfb' : '#202824',
    icons: [192, 512].map((size) => ({
      src: `/brand/${variant}-${size}.png`,
      sizes: `${size}x${size}`,
      type: 'image/png',
      purpose: 'any',
    })),
  };
  await writeFile(
    path.join(output, `${variant}.webmanifest`),
    JSON.stringify(manifest, null, 2) + '\n',
  );
}
run('magick', [
  path.join(root, 'assets/brand/day-original.png'),
  '-define',
  'icon:auto-resize=64,48,32,16',
  path.join(root, 'public/favicon.ico'),
]);

// Trace the supplied silhouette for Android's adaptive and monochrome layers.
// Its furthest point stays inside the 66 dp circular safe zone in a 108 dp tile.
const bitmap = path.join(temporary, 'mark.pbm');
const traced = path.join(temporary, 'mark.svg');
run('magick', [
  path.join(root, 'assets/brand/day-original.png'),
  '-colorspace',
  'Gray',
  '-threshold',
  '50%',
  bitmap,
]);
run('potrace', [bitmap, '--svg', '--opttolerance', '0.2', '--output', traced]);
const paths = [...(await readFile(traced, 'utf8')).matchAll(/<path d="([^"]+)"/g)].map((match) =>
  match[1].replace(/\s+/g, ' '),
);
if (paths.length !== 3) throw new Error('Expected the three supplied book-and-flame shapes');
const vector = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp" android:height="108dp"
    android:viewportWidth="108" android:viewportHeight="108">
    <group android:translateX="16.38" android:translateY="91.62"
        android:scaleX="0.006" android:scaleY="-0.006">
${paths.map((value) => `        <path android:fillColor="@color/brand_mark" android:pathData="${value}" />`).join('\n')}
    </group>
</vector>
`;
await writeFile(path.join(native, 'drawable/ic_launcher_foreground.xml'), vector);
console.log('Updated web icons, manifests, favicon and Android book-and-flame vectors.');
