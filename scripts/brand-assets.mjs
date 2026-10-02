import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Package the approved paths without retracing or changing their geometry.
// Generated assets are committed so ordinary builds do not need ImageMagick.
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
const mark = JSON.parse(await readFile(path.join(root, 'assets/brand/mark.json'), 'utf8'));
if (
  !Number.isFinite(mark.staffOffsetX) ||
  !['staff', 'leaf', 'pages'].every((part) => typeof mark[part] === 'string' && mark[part])
)
  throw new Error('Expected the approved staff, leaf and book paths');
for (const variant of ['day', 'night']) {
  const source = path.join(root, `assets/brand/${variant}-original.png`);
  const background = variant === 'day' ? '#F9F7F3' : '#155B57';
  const foreground = variant === 'day' ? '#155B57' : '#F9F7F3';
  const svg = path.join(temporary, `${variant}.svg`);
  await writeFile(
    svg,
    `<svg xmlns="http://www.w3.org/2000/svg" width="1254" height="1254" viewBox="0 0 1254 1254">
  <rect width="1254" height="1254" fill="${background}"/>
  <g fill="${foreground}" transform="translate(0 1254) scale(0.1 -0.1)">
    <g transform="translate(${mark.staffOffsetX} 0)">
      <path d="${mark.staff}"/>
      <path d="${mark.leaf}"/>
    </g>
    <path d="${mark.pages}"/>
  </g>
</svg>
`,
  );
  run('magick', [svg, '-strip', source]);
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
    background_color: variant === 'day' ? '#F9EFE2' : '#191817',
    theme_color: variant === 'day' ? '#F9EFE2' : '#191817',
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

// Reuse the same paths for Android's adaptive and monochrome layers.
// Its furthest point stays inside the 66 dp circular safe zone in a 108 dp tile.
const vector = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp" android:height="108dp"
    android:viewportWidth="108" android:viewportHeight="108">
    <group android:translateX="16.38" android:translateY="91.62"
        android:scaleX="0.006" android:scaleY="-0.006">
        <group android:translateX="${mark.staffOffsetX}">
            <path android:fillColor="@color/brand_mark" android:pathData="${mark.staff}" />
            <path android:fillColor="@color/brand_mark" android:pathData="${mark.leaf}" />
        </group>
        <path android:fillColor="@color/brand_mark" android:pathData="${mark.pages}" />
    </group>
</vector>
`;
await writeFile(path.join(native, 'drawable/ic_launcher_foreground.xml'), vector);

const qingli = path.join(root, 'public/qingli');
await mkdir(qingli, { recursive: true });
// Keep the supplied assistant silhouette as a transparent theme-color mask.
run('magick', [
  '-background',
  'none',
  path.join(root, 'assets/qingli/mark.svg'),
  '-trim',
  '+repage',
  '-resize',
  '900x900',
  '-gravity',
  'center',
  '-extent',
  '1024x1024',
  '-strip',
  path.join(root, 'assets/qingli/mark.png'),
]);
run('magick', [
  path.join(root, 'assets/qingli/mark.png'),
  '-resize',
  '128x128',
  '-strip',
  path.join(qingli, 'mark-128.png'),
]);
console.log('Updated web icons, manifests, favicon, Android vectors and Qingli mark.');
