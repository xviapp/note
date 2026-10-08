import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';

// Render flat paper shapes from the approved vector contours.
// Generated assets are committed so ordinary builds do not need ImageMagick.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'public/brand');
const native = path.join(root, 'android/app/src/main/res');
const palette = { paper: '#F8F2E8', green: '#526B60' };
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} failed`);
};
await mkdir(output, { recursive: true });
const mark = JSON.parse(await readFile(path.join(root, 'assets/brand/mark.json'), 'utf8'));
if (
  !Number.isFinite(mark.staffOffsetX) ||
  !['staff', 'leaf', 'pages'].every((part) => typeof mark[part] === 'string' && mark[part])
)
  throw new Error('Expected the approved staff, leaf and book paths');
// Keep the same paper background in every theme and system mode.
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
const svg = path.join(root, 'assets/brand/clay.svg');
await writeFile(
  svg,
  `<svg xmlns="http://www.w3.org/2000/svg" width="1254" height="1254" viewBox="0 0 1254 1254">
  <g transform="translate(627 627) scale(1.12) translate(-627 -627)">
  <g fill="${palette.green}" transform="translate(0 1254) scale(0.1 -0.1)">
    <g transform="translate(${mark.staffOffsetX} 0)">
      <path d="${mark.staff}"/>
      <path d="${mark.leaf}"/>
    </g>
    <path d="${mark.pages}"/>
  </g>
  </g>
</svg>
`,
);
// Chromium rasterizes the unchanged vector contours with transparent edges.
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined),
  args: ['--no-sandbox'],
});
const foreground = path.join(root, 'assets/brand/clay-foreground.png');
try {
  const page = await browser.newPage({ viewport: { width: 1254, height: 1254 }, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${await readFile(svg, 'utf8')}`);
  await page.screenshot({ path: foreground, omitBackground: true });
} finally {
  await browser.close();
}
run('magick', [foreground, '-background', palette.paper, '-alpha', 'remove', '-alpha', 'off', '-strip', source]);
await mkdir(path.join(native, 'drawable-nodpi'), { recursive: true });
run('magick', [foreground, '-strip', path.join(output, 'clay-foreground.png')]);
run('magick', [foreground, '-strip', path.join(native, 'drawable-nodpi/brand_clay.png')]);
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

// Retain vector contours for the monochrome layer; the colored layer uses flat fills.
// Its furthest point stays inside the 66 dp circular safe zone in a 108 dp tile.
const vector = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp" android:height="108dp"
    android:viewportWidth="108" android:viewportHeight="108">
    <group android:translateX="11.8656" android:translateY="96.1344"
        android:scaleX="0.00672" android:scaleY="-0.00672">
        <group android:translateX="${mark.staffOffsetX}">
            <path android:fillColor="@color/brand_mark" android:pathData="${mark.staff}" />
            <path android:fillColor="@color/brand_mark" android:pathData="${mark.leaf}" />
        </group>
        <path android:fillColor="@color/brand_mark" android:pathData="${mark.pages}" />
    </group>
</vector>
`;
await writeFile(path.join(native, 'drawable/ic_launcher_monochrome.xml'), vector);
await writeFile(path.join(native, 'drawable/ic_launcher_foreground.xml'), `<?xml version="1.0" encoding="utf-8"?>
<inset xmlns:android="http://schemas.android.com/apk/res/android" android:inset="16%">
    <bitmap android:src="@drawable/brand_clay" android:gravity="fill" />
</inset>
`);

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
console.log('Updated flat icons, manifests, favicon, Android layers and Qingli mark.');
