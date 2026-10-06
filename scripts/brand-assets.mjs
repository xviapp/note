import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Package the approved ink painting; derive every variant from the same artwork.
// Generated assets are committed so ordinary builds do not need ImageMagick.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'public/brand');
const native = path.join(root, 'android/app/src/main/res');
const temporary = path.join(root, '.wrangler/brand');
const palette = { paper: '#F9F2E7', green: '#426B55' };
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} failed`);
};
await mkdir(output, { recursive: true });
await mkdir(temporary, { recursive: true });
const painting = path.join(root, 'assets/brand/ink-original.png');
const inkMask = path.join(temporary, 'ink-mask.png');
// Remove the pale paper from the native foreground, retaining ink and dry-brush gaps.
// Discard faint paper fibres below 18% darkness; ink becomes opaque at 82%.
run('magick', [painting, '-colorspace', 'Gray', '-negate', '-level', '18%,82%', inkMask]);
// One white-paper icon in every theme and system mode; there is no dark variant.
const source = path.join(root, 'assets/brand/day-original.png');
await writeFile(
  path.join(native, 'values', 'ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${palette.paper}</color>
    <color name="brand_mark">${palette.green}</color>
</resources>
`,
);
const ink = path.join(temporary, 'day-ink.png');
run('magick', [painting, inkMask, '-alpha', 'off', '-compose', 'CopyOpacity', '-composite', ink]);
run('magick', [painting, '-strip', source]);
// Fit the entire square artwork into 66 dp; its ink stays within the circular safe zone.
const nativeOutput = path.join(native, 'drawable-nodpi');
await mkdir(nativeOutput, { recursive: true });
run('magick', [
  ink,
  '-resize',
  '264x264',
  '-gravity',
  'center',
  '-background',
  'none',
  '-extent',
  '432x432',
  '-strip',
  path.join(nativeOutput, 'brand_ink.png'),
]);
for (const size of [64, 128, 180, 192, 512])
  run('magick', [
    source,
    '-resize',
    `${size}x${size}`,
    '-strip',
    path.join(output, `day-${size}.png`),
  ]);
const manifest = {
  id: '/',
  name: '页间',
  short_name: '页间',
  lang: 'zh-CN',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#F9EFE2',
  theme_color: '#F9EFE2',
  icons: [192, 512].map((size) => ({
    src: `/brand/day-${size}.png`,
    sizes: `${size}x${size}`,
    type: 'image/png',
    purpose: 'any',
  })),
};
await writeFile(path.join(output, 'day.webmanifest'), JSON.stringify(manifest, null, 2) + '\n');
run('magick', [
  path.join(root, 'assets/brand/day-original.png'),
  '-define',
  'icon:auto-resize=64,48,32,16',
  path.join(root, 'public/favicon.ico'),
]);

// The native foreground and system-tinted monochrome icon share the same ink alpha.
const foreground = `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:width="108dp" android:height="108dp" android:gravity="center">
        <bitmap android:src="@drawable/brand_ink" android:gravity="fill" android:filter="true" />
    </item>
</layer-list>
`;
await writeFile(path.join(native, 'drawable/ic_launcher_foreground.xml'), foreground);

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
console.log('Updated web icons, manifests, favicon, Android ink layers and Qingli mark.');
