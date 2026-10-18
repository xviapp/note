import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { _android, expect } from '@playwright/test';

const { values } = parseArgs({
  options: {
    device: { type: 'string' },
    theme: { type: 'string', default: 'dark' },
    interaction: { type: 'boolean', default: false },
  },
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
const shell = (...args) => execFileSync(adb, ['-s', serial, 'shell', ...args], { encoding: 'utf8' });
shell('am', 'start', '-n', 'app.xvi.note/.MainActivity');
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
    const pathname = new URL(route.request().url()).pathname;
    const body =
      pathname === '/api/auth/status'
        ? { initialized: values.interaction, authenticated: values.interaction, name: '页间' }
        : pathname === '/api/storage'
          ? { allocatedBytes: 0, quotaBytes: 10_000_000 }
          : { nodes: [], nextOffset: null };
    await route
      .fulfill({
        contentType: 'application/json',
        body: JSON.stringify(body),
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
  if (values.interaction) {
    await checkInteraction();
  } else {
    const failures = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      authReady = new Promise((resolve) => {
        releaseAuth = resolve;
      });
      await page.goto(`https://iyi.li/?layout-check=${Date.now()}`);
      await expect(page.locator('.boot-screen')).toBeVisible();
      await page.waitForTimeout(1500);
      // App resume reapplies the theme. It must not remove/reapply system insets.
      shell('input', 'keyevent', 'KEYCODE_HOME');
      await page.waitForTimeout(200);
      shell('am', 'start', '-n', 'app.xvi.note/.MainActivity');
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
  }

  async function checkInteraction() {
    const bounds = (text) => {
      const match = text?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      assert(match, `无法读取原生边界：${text}`);
      const [, left, top, right, bottom] = match.map(Number);
      return { left, top, right, bottom };
    };
    const nativeBounds = () => {
      // UIAutomator waits for an idle layout and can time out on the very
      // resize loop this checks. Read the live native view hierarchy instead.
      const activity = shell('dumpsys', 'activity', 'top').match(
        /ACTIVITY app\.xvi\.note\/[^\n]+\n([\s\S]*?)(?=\n\s*ACTIVITY |$)/,
      )?.[1];
      const hierarchy = activity?.split('View Hierarchy:')[1]?.split('Looper (')[0];
      const parents = [];
      let webview;
      for (const line of hierarchy?.split('\n') || []) {
        const match = line.match(/^(\s+).*\{.*? (-?\d+),(-?\d+)-(-?\d+),(-?\d+)[ }]/);
        if (!match) continue;
        const depth = match[1].length;
        const [left, top, right, bottom] = match.slice(2).map(Number);
        while (parents.length && parents.at(-1).depth >= depth) parents.pop();
        const x = parents.at(-1)?.left || 0;
        const y = parents.at(-1)?.top || 0;
        const rect = { left: x + left, top: y + top, right: x + right, bottom: y + bottom };
        if (line.includes('app:id/webview')) {
          webview = rect;
          break;
        }
        parents.push({ ...rect, depth });
      }
      assert(webview, '没有找到页间 WebView。');
      const sources = shell('dumpsys', 'window', 'displays');
      const source = (type) =>
        sources.split('\n').find((line) =>
          line.includes(`type=${type} `) && line.includes(' visible=true '));
      return {
        webview,
        status: bounds(source('statusBars')),
        navigation: bounds(source('navigationBars')),
        ime: source('ime') ? bounds(source('ime')) : null,
      };
    };
    const checkBounds = (native, keyboard) => {
      assert(native.webview.top >= native.status.bottom, '页面覆盖了系统状态栏。');
      assert(native.webview.bottom <= native.navigation.top, '页面覆盖了系统导航栏。');
      if (keyboard) {
        assert(native.ime, '没有弹出真实软键盘，不能验证键盘遮挡。');
        assert(native.webview.bottom <= native.ime.top, '页面延伸到了键盘后方。');
      }
      assert(native.statusColor.every((value, i) => Math.abs(value - native.expectedColor[i]) <= 2),
        '系统状态栏背景与应用主题不一致。');
    };
    const saveNative = async (name) => {
      const native = nativeBounds();
      const screenshot = await device.screenshot();
      const color = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--surface').trim());
      assert(/^#[a-f\d]{6}$/i.test(color), '无法读取应用主题色。');
      const pixels = execFileSync('ffmpeg', [
        '-v', 'error', '-i', 'pipe:0', '-vf',
        `crop=2:2:${Math.floor((native.status.left + native.status.right) / 2)}:${native.status.bottom - 6}`,
        '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
      ], { input: screenshot });
      native.statusColor = [...pixels.subarray(0, 3)];
      native.expectedColor = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
      await writeFile(path.join(output, `${name}.json`), JSON.stringify(native, null, 2));
      await writeFile(path.join(output, `${name}.png`), screenshot);
      return native;
    };
    await page.goto(`https://iyi.li/?interaction-check=${Date.now()}`);
    await expect(page.locator('.app-shell')).toBeVisible();
    await page.waitForTimeout(500);
    const before = await saveNative('before');
    const issues = [];
    try {
      checkBounds(before, false);
    } catch (error) {
      issues.push(error.message);
    }
    const dialog = page.getByRole('dialog', { name: '新建笔记', exact: true });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await page.getByRole('button', { name: '新建', exact: true }).click();
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('标题', { exact: true }).click();
      await page.waitForTimeout(500);
      const frames = await page.evaluate(async () => {
        const result = [];
        for (let i = 0; i < 60; i++) {
          await new Promise(requestAnimationFrame);
          const modal = document.querySelector('dialog[open]');
          const input = modal.querySelector('input:not([type="radio"])').getBoundingClientRect();
          result.push({
            top: modal.getBoundingClientRect().top,
            inputTop: input.top,
            inputBottom: input.bottom,
            viewport: innerHeight,
          });
        }
        return result;
      });
      const native = await saveNative(`keyboard-${attempt}`);
      await writeFile(
        path.join(output, `keyboard-${attempt}-frames.json`), JSON.stringify(frames, null, 2),
      );
      const displacement =
        Math.max(...frames.map((f) => f.top)) - Math.min(...frames.map((f) => f.top));
      try {
        checkBounds(native, true);
        assert(displacement <= 1, '软键盘弹出后弹窗仍在上下跳动。');
        assert(
          frames.every((f) => f.inputTop >= 0 && f.inputBottom <= f.viewport),
          '标题输入框被键盘遮挡。',
        );
      } catch (error) {
        issues.push(error.message);
      }
      shell('input', 'keyevent', 'KEYCODE_BACK');
      await page.waitForTimeout(500);
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      const header = await page.locator('.app-header').boundingBox();
      assert(header && header.y >= 0, '关闭弹窗后页间顶栏移出了页面。');
      const after = await saveNative(`after-${attempt}`);
      try {
        checkBounds(after, false);
      } catch (error) {
        issues.push(error.message);
      }
      await page.getByRole('button', { name: '打开笔记目录', exact: true }).click();
      await expect(page.locator('.app-shell')).toHaveClass(/sidebar-open/);
      await page.getByRole('button', { name: '关闭侧栏', exact: true }).click();
      console.log({ attempt, theme: values.theme, displacement, native });
    }
    assert.deepEqual(issues, [], `交互布局异常，检查 ${output}`);
    console.log('PASS: 新建笔记、软键盘及系统栏边界检查通过', { output });
  }
} finally {
  releaseAuth();
  await device.close();
}
