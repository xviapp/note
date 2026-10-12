import { test, expect, type Page } from './fixtures';
import { login } from './notebook-helpers';
import type { NoteNode } from '../shared/types';

// Android's floating windows (window.html) opened from launcher shortcuts,
// with the native bridge mocked.
const headers = { origin: 'http://127.0.0.1:8799' };
async function openWindow(page: Page, kind: 'journal' | 'assistant') {
  await page.addInitScript((action) => {
    const win = window as any;
    win.androidBridge = {};
    win.__calls = [];
    win.Capacitor = {
      PluginHeaders: [
        {
          name: 'NoteDevice',
          methods: ['takeLaunch', 'hideWindow', 'closeWindow', 'finishBoot', 'setBackground', 'notify', 'setWindowState'].map(
            (name) => ({ name, rtype: 'promise' }),
          ),
        },
      ],
      nativePromise: async (_plugin: string, method: string, options: any) => {
        if (method === 'takeLaunch') return { action };
        if (method === 'hideWindow' || method === 'closeWindow') win.__calls.push([method, options ?? {}]);
        if (method === 'finishBoot') win.__ready = true;
        return {};
      },
    };
  }, kind);
  await page.goto('/window.html');
}
const calls = (page: Page) => page.evaluate(() => (window as any).__calls);
const today = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};

test('今日记 appends a titled record to today in the latest journal', async ({ page }, info) => {
  await login(page);
  const journal = (await (
    await page.request.post('/api/nodes', { headers, data: { kind: 'folder', title: '我的日记', journal: true } })
  ).json()) as NoteNode;
  await openWindow(page, 'journal');
  const dialog = page.getByRole('dialog', { name: '今日记', exact: true });
  await expect(dialog.getByText(/我的日记/)).toBeVisible();
  await dialog.getByLabel('记录标题', { exact: true }).fill('午后');
  await dialog.getByPlaceholder('记下此刻…').fill('窗外下起了雨。');
  await page.screenshot({ path: `test-results/window-journal-${info.project.name}.png` });
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => calls(page)).toEqual([
    ['hideWindow', {}],
    ['closeWindow', { message: '已记入今日日记' }],
  ]);
  const month = await (await page.request.get(`/api/nodes/${journal.id}/journal?month=${today().slice(0, 7)}`)).json();
  const entry = month.entries.find((item: { date: string }) => item.date === today());
  expect(entry).toBeTruthy();
  const detail = await (await page.request.get(`/api/nodes/${entry.id}`)).json();
  expect(detail.content).toContain('午后');
  expect(detail.content).toContain('窗外下起了雨。');
});

test('今日记 asks for a journal when there is none', async ({ page }) => {
  await login(page);
  await openWindow(page, 'journal');
  const dialog = page.getByRole('dialog', { name: '今日记', exact: true });
  await expect(dialog.getByText(/还没有日记本/)).toBeVisible();
  await dialog.getByRole('button', { name: '打开页间', exact: true }).click();
  await expect.poll(() => calls(page)).toEqual([['closeWindow', { path: '/' }]]);
});

test('问青藜 floats the global conversation and closes the window with it', async ({ page }, info) => {
  await login(page);
  await page.request.put('/api/ai/settings', {
    headers,
    data: { apiKey: 'sk-e2e-placeholder-key', maxTokens: 8192 },
  });
  // The global conversation outlives the library reset between tests.
  await page.request.delete('/api/nodes/qingli-global/assistant', { headers });
  await openWindow(page, 'assistant');
  const panel = page.locator('.assistant-panel:not([hidden])');
  const input = panel.getByRole('textbox', { name: '发给青藜的问题', exact: true });
  await expect(input).toBeVisible();
  await input.fill('你好');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect(panel.locator('.chat-message')).toHaveCount(2);
  await page.screenshot({ path: `test-results/window-assistant-${info.project.name}.png` });
  await panel.getByRole('button', { name: '关闭青藜', exact: true }).click();
  await expect.poll(() => calls(page)).toEqual([['closeWindow', {}]]);
});

test('今日记 opens from this device’s cache while the server is slow', async ({ page }) => {
  await login(page);
  await page.request.post('/api/nodes', { headers, data: { kind: 'folder', title: '慢网日记', journal: true } });
  await openWindow(page, 'journal');
  const dialog = page.getByRole('dialog', { name: '今日记', exact: true });
  await expect(dialog.getByText(/慢网日记/)).toBeVisible();
  // Every request now hangs: the second opening must not wait for the network.
  await page.route('**/api/**', () => {});
  await page.reload();
  await expect(dialog.getByText(/慢网日记/)).toBeVisible({ timeout: 2000 });
  await expect(dialog.getByPlaceholder('记下此刻…')).toBeVisible();
});

test('问青藜 opens on the last conversation while the server is slow', async ({ page }) => {
  await login(page);
  await page.request.put('/api/ai/settings', {
    headers,
    data: { apiKey: 'sk-e2e-placeholder-key', maxTokens: 8192 },
  });
  // The global conversation outlives the library reset between tests.
  await page.request.delete('/api/nodes/qingli-global/assistant', { headers });
  await openWindow(page, 'assistant');
  const panel = page.locator('.assistant-panel:not([hidden])');
  await panel.getByRole('textbox', { name: '发给青藜的问题', exact: true }).fill('记得这个问题');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect(panel.locator('.chat-message')).toHaveCount(2);
  // The window tells Android its card is drawn, so the native stand-in can go.
  expect(await page.evaluate(() => (window as any).__ready)).toBe(true);
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeVisible();
  await page.route('**/api/**', () => {});
  await page.reload();
  await expect(panel.getByText('记得这个问题')).toBeVisible({ timeout: 2000 });
});

test('今日记 writes to the journal chosen in settings', async ({ page }, info) => {
  await login(page);
  const make = async (title: string) =>
    (await (await page.request.post('/api/nodes', { headers, data: { kind: 'folder', title, journal: true } })).json()) as NoteNode;
  const work = await make('工作日志');
  const life = await make('生活日记');
  await page.request.post(`/api/nodes/${life.id}/journal/entries`, { headers, data: { date: '2026-01-02', content: '旧的' } });
  await page.goto('/settings/share');
  const select = page.getByLabel('今日记保存到');
  await expect(select).toHaveValue('');
  await select.selectOption({ label: '工作日志' });
  await expect.poll(async () => (await (await page.request.get('/api/journals/quick')).json()).journalId).toBe(work.id);
  await page.screenshot({ path: `test-results/settings-quick-journal-${info.project.name}.png` });
  await openWindow(page, 'journal');
  await expect(page.getByRole('dialog', { name: '今日记', exact: true }).getByText(/工作日志/)).toBeVisible();
});

test('今日记 keeps typing during a photo upload and saves in the background', async ({ page }, info) => {
  await login(page);
  const journal = (await (
    await page.request.post('/api/nodes', { headers, data: { kind: 'folder', title: '照片日记', journal: true } })
  ).json()) as NoteNode;
  let release!: () => void;
  const uploaded = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/files?**', async (route) => {
    await uploaded;
    await route.continue();
  });
  await openWindow(page, 'journal');
  const dialog = page.getByRole('dialog', { name: '今日记', exact: true });
  await expect(dialog.getByText(/照片日记/)).toBeVisible();
  await dialog.getByLabel('添加照片').setInputFiles({
    name: '窗外.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'),
  });
  await expect(dialog.getByRole('status')).toContainText('正在上传 1 张照片');
  await dialog.getByPlaceholder('记下此刻…').fill('雨停了。');
  await page.screenshot({ path: `test-results/window-journal-uploading-${info.project.name}.png` });
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  // The window steps aside at once and closes only after the photo and record are saved.
  await expect.poll(() => calls(page)).toEqual([['hideWindow', {}]]);
  release();
  await expect.poll(() => calls(page)).toEqual([
    ['hideWindow', {}],
    ['closeWindow', { message: '已记入今日日记' }],
  ]);
  const month = await (await page.request.get(`/api/nodes/${journal.id}/journal?month=${today().slice(0, 7)}`)).json();
  const entry = month.entries.find((item: { date: string }) => item.date === today());
  const detail = await (await page.request.get(`/api/nodes/${entry.id}`)).json();
  expect(detail.content).toContain('雨停了。');
  expect(detail.content).toMatch(/!\[窗外\.png\]\(\/api\/files\/[\w-]+\)/);
  expect(detail.attachments.map((file: { name: string }) => file.name)).toEqual(['窗外.png']);
});

test('今日记 takes records for a locked journal and adds them once it is unlocked', async ({ page }, info) => {
  await login(page);
  const journal = (await (
    await page.request.post('/api/nodes', { headers, data: { kind: 'folder', title: '加密日记', journal: true } })
  ).json()) as NoteNode;
  await page.goto(`/n/${journal.id}`);
  await page.getByRole('button', { name: '管理 加密日记' }).first().click();
  await page.getByRole('button', { name: '本地加密' }).click();
  const encryption = page.getByRole('dialog');
  await encryption.getByRole('button', { name: '设置密码' }).click();
  await encryption.getByLabel('密码', { exact: true }).fill('diary-secret');
  await encryption.getByLabel('再次输入').fill('diary-secret');
  await encryption.getByRole('button', { name: '设置并加密' }).click();
  await encryption.getByRole('button', { name: '立即锁定' }).click();
  await expect(encryption.getByRole('button', { name: '立即锁定' })).toHaveCount(0);

  // The window takes the record without the password.
  await openWindow(page, 'journal');
  const dialog = page.getByRole('dialog', { name: '今日记', exact: true });
  await expect(dialog.getByText('日记本已加密：先存在本设备，解锁后自动记入。')).toBeVisible();
  await dialog.getByLabel('记录标题').fill('秘密');
  await dialog.getByPlaceholder('记下此刻…').fill('只写给自己。');
  await page.screenshot({ path: `test-results/window-journal-locked-${info.project.name}.png` });
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => calls(page)).toEqual([
    ['closeWindow', { message: '已暂存在本设备，解锁「加密日记」后自动记入今日日记' }],
  ]);
  const month = () => page.request.get(`/api/nodes/${journal.id}/journal?month=${today().slice(0, 7)}`).then((r) => r.json());
  expect((await month()).entries).toEqual([]);

  // 设置 → 待发送 shows it waiting for the journal; unlocking there adds it to today's entry.
  const app = await page.context().newPage();
  await app.goto('/settings/outbox');
  const waiting = app.getByRole('region', { name: '今日记' });
  await expect(waiting.getByText('秘密')).toBeVisible();
  await expect(waiting.getByText('等待解锁「加密日记」')).toBeVisible();
  await waiting.getByRole('button', { name: '去解锁' }).click();
  await app.getByLabel('「加密日记」的密码').fill('diary-secret');
  await app.getByRole('button', { name: '解锁', exact: true }).click();
  await expect(app.getByText('已把暂存的 1 条今日记记入日记')).toBeVisible();
  await expect.poll(async () => (await month()).entries.map((entry: { date: string }) => entry.date)).toEqual([today()]);
});

test('unlocking in the 今日记 window keeps what was written', async ({ page }) => {
  await login(page);
  const journal = (await (
    await page.request.post('/api/nodes', { headers, data: { kind: 'folder', title: '锁着的日记', journal: true } })
  ).json()) as NoteNode;
  await page.goto(`/n/${journal.id}`);
  await page.getByRole('button', { name: '管理 锁着的日记' }).first().click();
  await page.getByRole('button', { name: '本地加密' }).click();
  const encryption = page.getByRole('dialog');
  await encryption.getByRole('button', { name: '设置密码' }).click();
  await encryption.getByLabel('密码', { exact: true }).fill('diary-secret');
  await encryption.getByLabel('再次输入').fill('diary-secret');
  await encryption.getByRole('button', { name: '设置并加密' }).click();
  await encryption.getByRole('button', { name: '立即锁定' }).click();
  await expect(encryption.getByRole('button', { name: '立即锁定' })).toHaveCount(0);
  await openWindow(page, 'journal');
  const dialog = page.getByRole('dialog', { name: '今日记', exact: true });
  await dialog.getByPlaceholder('记下此刻…').fill('先写着');
  await dialog.getByRole('button', { name: '现在解锁' }).click();
  await dialog.getByLabel('「锁着的日记」的密码').fill('diary-secret');
  await dialog.getByRole('button', { name: '解锁', exact: true }).click();
  await expect(dialog.getByText('日记本已加密：先存在本设备，解锁后自动记入。')).toHaveCount(0);
  await expect(dialog.getByPlaceholder('记下此刻…')).toHaveValue('先写着');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => calls(page)).toContainEqual(['closeWindow', { message: '已记入今日日记' }]);
});
