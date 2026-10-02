import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  throw new Error('请用 --device emulator-端口 指定已安装页间的临时模拟器；此检查不允许真机。');
if (!['light', 'dark', 'starry', 'system'].includes(values.theme))
  throw new Error('--theme 支持 light、dark、starry 或 system。');
const sdk = [
  process.env.ANDROID_SDK_ROOT,
  process.env.ANDROID_HOME,
  path.join(homedir(), 'Android/Sdk'),
  path.join(homedir(), 'Library/Android/sdk'),
].find((value) => value && existsSync(path.join(value, 'platform-tools')));
if (!sdk) throw new Error('缺少 Android SDK。');
const adb = path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
execFileSync(adb, ['-s', serial, 'shell', 'am', 'start', '-n', 'app.xvi.note/.MainActivity']);
const devices = await _android.devices();
const device = devices.find((item) => item.serial() === serial);
await Promise.all(devices.filter((item) => item !== device).map((item) => item.close()));
if (!device) throw new Error('找不到指定模拟器。');
const output = path.resolve('.wrangler', `layout-${values.theme}-${Date.now()}`);
await mkdir(output, { recursive: true });
let releaseAuth = () => {};
try {
  const page = await (await device.webView({ pkg: 'app.xvi.note' })).page();
  page.setDefaultTimeout(15_000);
  await page.emulateMedia({ colorScheme: null });
  let authReady = Promise.resolve();
  // Hold only a mocked auth response so a slow network exposes the full boot
  // layout. This never submits credentials or accesses production notebook data.
  await page.route('**/api/**', async (route) => {
    await authReady;
    await route
      .fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ initialized: false, authenticated: false, name: '页间' }),
      })
      .catch(() => {}); // Navigation/teardown can cancel a held request.
  });
  await page.addInitScript((theme) => {
    localStorage.setItem('note:theme', theme);
    window.__noteLayoutFrames = [];
    const start = performance.now();
    const sample = () => {
      const brand = document.querySelector('.boot-screen .brand');
      if (brand) {
        const box = brand.getBoundingClientRect();
        window.__noteLayoutFrames.push({
          ms: performance.now(),
          viewport: innerHeight,
          top: box.top,
          left: box.left,
          width: box.width,
          height: box.height,
        });
      }
      if (performance.now() - start < 10_000) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, values.theme);
  const failures = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    authReady = new Promise((resolve) => {
      releaseAuth = resolve;
    });
    await page.goto(`https://note.xvi.app/?layout-check=${Date.now()}`);
    await expect(page.locator('.boot-screen')).toBeVisible();
    await page.waitForTimeout(1500);
    // App resume reapplies the theme. It must not remove/reapply system insets.
    execFileSync(adb, ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_HOME']);
    await page.waitForTimeout(200);
    execFileSync(adb, ['-s', serial, 'shell', 'am', 'start', '-n', 'app.xvi.note/.MainActivity']);
    await page.waitForTimeout(500);
    const frames = await page.evaluate(() => window.__noteLayoutFrames);
    await writeFile(path.join(output, `attempt-${attempt}.json`), JSON.stringify(frames, null, 2));
    assert(frames.length >= 20, '没有捕捉到足够的加载页帧。');
    const displacement =
      Math.max(...frames.map((f) => f.top)) - Math.min(...frames.map((f) => f.top));
    const viewportChange =
      Math.max(...frames.map((f) => f.viewport)) - Math.min(...frames.map((f) => f.viewport));
    console.log({ attempt, theme: values.theme, displacement, viewportChange });
    if (displacement > 1 || viewportChange > 1) failures.push(attempt);
    releaseAuth();
    await expect(page.locator('.auth-form')).toBeVisible();
  }
  assert.equal(failures.length, 0, `加载页发生位移，检查 ${output}`);
  console.log('PASS: 初始化及重复主题同步未改变加载页位置', { output });
} finally {
  releaseAuth();
  await device.close();
}
