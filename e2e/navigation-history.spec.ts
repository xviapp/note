import { expect, test, type Page } from '@playwright/test';
import { preparePassword } from '../shared/password';

const headers = { origin: 'http://127.0.0.1:8799' };
async function login(page: Page) {
  const status = await (await page.request.get('/api/auth/status')).json();
  const response = await page.request.post(`/api/auth/${status.initialized ? 'login' : 'setup'}`, {
    headers,
    data: {
      password: await preparePassword('Note2026', status.initialized ? status.password : undefined),
      ...(!status.initialized ? { token: 'e2e-test-only-setup-token-never-deploy-0001' } : {}),
    },
  });
  expect(response.ok()).toBeTruthy();
}

test('returning to a long list reuses loaded pages and restores its scroll position', async ({
  page,
}) => {
  await login(page);
  const note = await (
    await page.request.post('/api/nodes', {
      headers,
      data: { kind: 'markdown', title: '第二页笔记' },
    })
  ).json();
  const firstPage = Array.from({ length: 30 }, (_, index) => ({
    ...note,
    id: `first-${index}`,
    title: `笔记 ${index + 1}`,
  }));
  let firstLoads = 0,
    secondLoads = 0;
  await page.route('**/api/nodes?view=favorites*', async (route) => {
    const second = new URL(route.request().url()).searchParams.has('offset');
    if (second) secondLoads++;
    else firstLoads++;
    await route.fulfill({
      json: { nodes: second ? [note] : firstPage, nextOffset: second ? null : 30 },
    });
  });
  await page.goto('/favorites');
  await page.locator('.node-list').getByRole('button', { name: '加载更多', exact: true }).click();
  const target = page.locator('.node-list-main').filter({ hasText: note.title });
  await target.scrollIntoViewIfNeeded();
  const before = await page.locator('.main-content').evaluate((element) => element.scrollTop);
  expect(before).toBeGreaterThan(800);
  await target.click();
  await expect(page.locator('.document-heading h1')).toHaveText(note.title);
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect(page).toHaveURL(/\/favorites$/);
  await expect(page.locator('.node-list-row')).toHaveCount(31);
  await expect(target).toBeInViewport();
  await expect
    .poll(() => page.locator('.main-content').evaluate((element) => element.scrollTop))
    .toBeCloseTo(before, 0);
  // Returning shows the loaded listing without fetching it again.
  expect(firstLoads).toBe(1);
  expect(secondLoads).toBe(1);
});

test('folder icons are downloaded once and reused after returning or reloading', async ({
  page,
}, info) => {
  await login(page);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkaPhfDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const icon = await (
    await page.request.post(`/api/files?name=icon.png&size=${png.length}`, {
      headers,
      data: png,
    })
  ).json();
  const parent = await (
    await page.request.post('/api/nodes', {
      headers,
      data: { kind: 'folder', title: `图标缓存 ${info.project.name}` },
    })
  ).json();
  const title = `带图标 ${info.project.name}`;
  await page.request.post('/api/nodes', {
    headers,
    data: { kind: 'folder', title, parentId: parent.id, icon: { fileId: icon.id } },
  });
  let downloads = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === `/api/files/${icon.id}`) downloads++;
  });
  const image = page
    .locator('.node-list-main')
    .filter({ hasText: title })
    .locator('.custom-folder-icon img');
  const loaded = () => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth);
  await page.goto(`/n/${parent.id}`);
  await expect.poll(loaded).toBe(1);
  await page.locator('.node-list-main').filter({ hasText: title }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect.poll(loaded).toBe(1);
  await page.reload();
  await expect.poll(loaded).toBe(1);
  expect(downloads).toBe(1);
});

test('settings and offline list deep links can be reloaded without a network', async ({
  page,
  context,
}) => {
  await login(page);
  await page.goto('/settings/reading');
  await expect(page.locator('.reading-controls')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.offline-banner')).toBeVisible();
  await expect(page.locator('.reading-controls')).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/reading$/);
  await page.goto('/offline');
  await expect(page.getByRole('heading', { name: '还没有缓存的文件', exact: true })).toBeVisible();
  await expect(page.locator('.offline-banner')).toBeVisible();
  await context.setOffline(false);
});

test('320px reading controls keep menus and bottom sheets accessible', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'Narrow phone layout');
  await login(page);
  const note = await (
    await page.request.post('/api/nodes', {
      headers,
      data: { kind: 'markdown', title: '小屏阅读' },
    })
  ).json();
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(`/n/${note.id}`);
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: '阅读设置', exact: true });
  const box = (await sheet.boundingBox())!;
  expect(box.width).toBe(320);
  expect(box.y + box.height).toBeCloseTo(640, 0);
  await page.keyboard.press('Escape');
  const menu = page.locator('.note-actions .node-menu');
  await menu.getByRole('button', { name: '管理 小屏阅读', exact: true }).click();
  const rename = menu.getByRole('button', { name: '重命名', exact: true });
  await expect(rename).toBeInViewport();
  expect((await rename.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  await rename.click();
  await expect(page.getByRole('dialog', { name: '修改笔记信息', exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
});
