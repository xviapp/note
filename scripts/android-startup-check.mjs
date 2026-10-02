import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { _android, expect } from '@playwright/test';

const { values } = parseArgs({
  options: { device: { type: 'string' }, theme: { type: 'string', default: 'dark' } },
});
const serial = values.device;
if (!/^emulator-\d+$/.test(serial || ''))
  throw new Error(
    '请用 --device emulator-端口 指定已安装页间的临时 Android 14 模拟器；此检查不允许真机。',
  );
if (!['dark', 'starry', 'system'].includes(values.theme))
  throw new Error('--theme 支持 dark、starry 或 system（系统深色）。');
const sdk = [
  process.env.ANDROID_SDK_ROOT,
  process.env.ANDROID_HOME,
  path.join(homedir(), 'Android/Sdk'),
  path.join(homedir(), 'Library/Android/sdk'),
].find((value) => value && existsSync(path.join(value, 'platform-tools')));
if (!sdk) throw new Error('缺少 Android SDK。');
const adb = path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const run = (args) => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8' });
execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const output = path.resolve('.wrangler', `startup-${values.theme}-${Date.now()}`);
await mkdir(output, { recursive: true });

run(['shell', 'cmd', 'uimode', 'night', 'yes']);
run(['shell', 'am', 'start', '-n', 'app.xvi.note/.MainActivity']);
const devices = await _android.devices();
const device = devices.find((item) => item.serial() === serial);
await Promise.all(devices.filter((item) => item !== device).map((item) => item.close()));
if (!device) throw new Error('找不到指定模拟器。');
try {
  const page = await (await device.webView({ pkg: 'app.xvi.note' })).page();
  await page.emulateMedia({ colorScheme: null });
  // Seed only a local appearance preference on a disposable emulator. The
  // mock login never submits a password or creates production content.
  await page.route('**/api/**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ initialized: true, authenticated: false, name: '页间' }),
    }),
  );
  await page.goto(`https://note.xvi.app/?startup-check=${Date.now()}`);
  await expect(page.locator('.auth-form')).toBeVisible();
  await page
    .getByRole('combobox', { name: '主题', exact: true, includeHidden: true })
    .selectOption(values.theme);
  await expect(page.locator('html')).toHaveAttribute(
    'data-theme',
    values.theme === 'system' ? 'dark' : values.theme,
  );
  // WebView batches localStorage disk commits. Let the selected theme persist
  // before force-stop; otherwise the recording may boot the previous palette.
  await pause(6000);
} finally {
  await device.close();
}

run(['shell', 'am', 'force-stop', 'app.xvi.note']);
run(['shell', 'input', 'keyevent', '3']);
await pause(600);
const remote = `/sdcard/yejian-startup-${Date.now()}.mp4`;
const recording = path.join(output, 'startup.mp4');
const recorder = spawn(
  adb,
  ['-s', serial, 'shell', 'screenrecord', '--bit-rate', '12000000', '--time-limit', '6', remote],
  { stdio: 'inherit' },
);
const recorded = new Promise((resolve, reject) => {
  recorder.on('error', reject);
  recorder.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`录屏失败：${code}`))));
});
await pause(500);
run(['shell', 'am', 'start', '-n', 'app.xvi.note/.MainActivity']);
await recorded;
run(['pull', remote, recording]);
run(['shell', 'rm', remote]);
const frames = execFileSync(
  'ffmpeg',
  [
    '-v',
    'error',
    '-i',
    recording,
    '-vf',
    'fps=60,scale=54:120',
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    'pipe:1',
  ],
  { maxBuffer: 20 * 1024 * 1024 },
);
const size = 54 * 120 * 3;
const metrics = [];
for (let offset = 0; offset + size <= frames.length; offset += size) {
  let bright = 0,
    teal = 0,
    black = 0,
    pale = 0,
    total = 0;
  for (let y = 12; y < 108; y++)
    for (let x = 4; x < 50; x++) {
      const pixel = offset + (y * 54 + x) * 3;
      const [r, g, b] = frames.subarray(pixel, pixel + 3);
      if (r > 230 && g > 230 && b > 230) bright++;
      if (Math.abs(r - 21) < 25 && Math.abs(g - 91) < 25 && Math.abs(b - 87) < 25) teal++;
      if (r < 5 && g < 5 && b < 5) black++;
      // Exclude the centered logo/text. A bright canvas under Android's radial
      // splash exit appears as a pale bloom, even before it is fully white.
      if (!(x >= 13 && x <= 40 && y >= 42 && y <= 78) && r > 45 && g > 110 && b > 107) pale++;
      total++;
    }
  metrics.push({
    ms: Math.round((offset / size / 60) * 1000),
    bright: bright / total,
    teal: teal / total,
    black: black / total,
    pale: pale / total,
  });
}
await writeFile(path.join(output, 'frames.json'), JSON.stringify(metrics, null, 2));
const start = metrics.findIndex((frame) => frame.teal > 0.95);
if (start < 0) throw new Error(`未捕捉到完整夜间 Splash，检查录屏：${output}`);
if (metrics.at(-1).teal > 0.2) throw new Error(`Splash 未退出，检查录屏：${output}`);
const flashes = metrics
  .slice(start)
  .filter((frame) => frame.bright > 0.9 || frame.black > 0.9 || frame.pale > 0.06);
if (flashes.length) {
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-ss',
    String(flashes[0].ms / 1000),
    '-i',
    recording,
    '-frames:v',
    '1',
    path.join(output, 'flash.png'),
  ]);
  console.error('FAIL: Splash 退场出现亮帧或空白帧', {
    frames: flashes.length,
    firstMs: flashes[0].ms,
    lastMs: flashes.at(-1).ms,
    output,
  });
  process.exitCode = 1;
} else console.log('PASS: Splash 到首屏没有亮帧或空白帧', { theme: values.theme, output });
