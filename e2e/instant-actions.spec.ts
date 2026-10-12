import { test, expect } from './fixtures';
import { login } from './notebook-helpers';

// Actions show at once and are withdrawn if the server refuses them.
const headers = { origin: 'http://127.0.0.1:8799' };
const create = async (page: import('@playwright/test').Page, title: string) =>
  (await (await page.request.post('/api/nodes', { headers, data: { kind: 'markdown', title, content: title } })).json()) as { id: string };

test('favorite shows at once and is withdrawn when refused', async ({ page }) => {
  await login(page);
  const note = await create(page, '即时收藏');
  await page.goto(`/n/${note.id}`);
  let answer!: (status: number) => void;
  const reply = new Promise<number>((resolve) => (answer = resolve));
  await page.route(`**/api/nodes/${note.id}/favorite`, async (route) => {
    const status = await reply;
    await (status === 200 ? route.continue() : route.fulfill({ status, json: { error: '收藏暂时失败' } }));
  });
  await page.getByRole('button', { name: '收藏笔记' }).click();
  await expect(page.getByRole('button', { name: '取消收藏' })).toBeVisible();
  answer(503);
  await expect(page.getByRole('button', { name: '收藏笔记' })).toBeVisible();
  await expect(page.getByRole('alert').first()).toContainText('收藏暂时失败');
});

test('a deleted note leaves the list before the server answers', async ({ page }) => {
  await login(page);
  await create(page, '马上删除的笔记');
  await page.goto('/');
  const list = page.locator('.main-content');
  const row = list.getByText('马上删除的笔记');
  await expect(row).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/nodes/*', async (route) => {
    if (route.request().method() === 'DELETE') await gate;
    await route.fallback();
  });
  await list.getByRole('button', { name: '管理 马上删除的笔记' }).first().click();
  await page.getByRole('button', { name: '移到回收站' }).click();
  await expect(row).toHaveCount(0);
  release();
  await expect(page.getByText('「马上删除的笔记」已移到回收站')).toBeVisible();
});

test('search shows titles from this device while the server searches', async ({ page }) => {
  await login(page);
  await create(page, '本机能找到的标题');
  await page.goto('/');
  await expect(page.locator('.main-content').getByText('本机能找到的标题')).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/search?q=*', async (route) => {
    await gate;
    await route.continue();
  });
  await page.locator('.app-header').getByRole('button', { name: '搜索笔记' }).click();
  const dialog = page.getByRole('dialog', { name: '搜索笔记', exact: true });
  const searching = page.waitForRequest('**/api/search?q=*');
  await dialog.getByRole('combobox').fill('本机 标题');
  await expect(dialog.locator('.search-caption')).toHaveText('找到 1 项，继续查找中…');
  await expect(dialog.getByRole('option')).toHaveText(['本机能找到的标题']);
  await searching;
  release();
  await expect(dialog.locator('.search-caption')).toHaveText('找到 1 项');
});
