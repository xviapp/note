import { expect, test, type Page } from './fixtures';
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
async function openSidebar(page: Page) {
  await expect(page.locator('.app-shell')).toBeVisible();
  const button = page.getByRole('button', { name: '打开笔记目录', exact: true });
  if (await button.isVisible()) await button.click();
  await expect(page.getByRole('button', { name: '刷新目录', exact: true })).toBeEnabled();
}
async function create(page: Page, data: object) {
  const response = await page.request.post('/api/nodes', { headers, data });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test('reopening the mobile sidebar refreshes changes made by another client', async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile', 'Mobile drawer lifecycle');
  await login(page);
  const folder = await (
    await page.request.post('/api/nodes', {
      headers,
      data: { kind: 'folder', title: '旧目录名称' },
    })
  ).json();
  await page.goto('/');
  await page.getByRole('button', { name: '打开笔记目录', exact: true }).click();
  await expect(page.locator('.tree-label').filter({ hasText: '旧目录名称' })).toBeVisible();
  await page.getByRole('button', { name: '关闭侧栏', exact: true }).click();
  const renamed = await page.request.patch(`/api/nodes/${folder.id}`, {
    headers,
    data: { revision: folder.revision, title: '已更新的目录' },
  });
  expect(renamed.ok()).toBeTruthy();
  await page.getByRole('button', { name: '打开笔记目录', exact: true }).click();
  await expect(page.locator('.tree-label').filter({ hasText: '已更新的目录' })).toBeVisible({
    timeout: 3000,
  });
  await expect(page.locator('.tree-label').filter({ hasText: '旧目录名称' })).toHaveCount(0);
});

test('returning to the foreground refreshes the already open directory', async ({ page }, info) => {
  await login(page);
  const folder = await (
    await page.request.post('/api/nodes', {
      headers,
      data: { kind: 'folder', title: `切回前的目录 ${info.project.name}` },
    })
  ).json();
  await page.goto('/');
  await openSidebar(page);
  await expect(page.locator('.tree-label').filter({ hasText: folder.title })).toBeVisible();
  await page.request.patch(`/api/nodes/${folder.id}`, {
    headers,
    data: { revision: folder.revision, title: `切回后的目录 ${info.project.name}` },
  });
  const authCheck = page.waitForResponse((response) => response.url().endsWith('/api/auth/status'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect((await (await authCheck).json()).authenticated).toBe(true);
  await expect(
    page.locator('.tree-label').filter({ hasText: `切回后的目录 ${info.project.name}` }),
  ).toBeVisible({
    timeout: 3000,
  });
});

test('manual refresh preserves expanded branches and loaded pages, including after a failed refresh', async ({
  page,
}, info) => {
  await login(page);
  const folder = await create(page, { kind: 'folder', title: `分页目录 ${info.project.name}` });
  // Only folders with children show an expand arrow; the listing below is mocked.
  await create(page, { kind: 'markdown', title: '占位', parentId: folder.id });
  let version = '原';
  let failing = false;
  let secondPages = 0;
  const child = (index: number) => ({
    ...folder,
    id: `${folder.id}-${index}`,
    parent_id: folder.id,
    title: `${version}子目录${index}`,
  });
  await page.route(`**/api/nodes?parent=${folder.id}*`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('parent') !== folder.id) return route.continue();
    if (url.searchParams.has('offset')) secondPages++;
    if (failing)
      return route.fulfill({ status: 503, json: { error: '目录暂时无法读取，请重试。' } });
    await route.fulfill({
      json: url.searchParams.has('offset')
        ? { nodes: [child(3)], nextOffset: null }
        : { nodes: [child(1), child(2)], nextOffset: 2 },
    });
  });
  await page.goto('/');
  await openSidebar(page);
  await page
    .locator('.tree')
    .getByRole('button', { name: `展开 ${folder.title}`, exact: true })
    .click();
  await page.locator('.tree').getByRole('button', { name: '加载更多', exact: true }).click();
  await expect(page.locator('.tree-label').filter({ hasText: '原子目录3' })).toBeVisible();
  const refresh = page.getByRole('button', { name: '刷新目录', exact: true });
  const panel = page.locator('.sidebar-tree');
  await panel.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const panelBox = await panel.boundingBox();
  const refreshBox = await refresh.boundingBox();
  expect(refreshBox!.y).toBeGreaterThanOrEqual(panelBox!.y);
  expect(refreshBox!.y + refreshBox!.height).toBeLessThanOrEqual(panelBox!.y + panelBox!.height);
  failing = true;
  await refresh.click();
  await expect(page.locator('.tree')).toContainText('目录暂时无法读取');
  await expect(page.locator('.tree-label').filter({ hasText: '原子目录3' })).toBeVisible();
  failing = false;
  version = '新';
  await refresh.click();
  await expect(page.locator('.tree-label').filter({ hasText: '新子目录3' })).toBeVisible();
  await expect(page.locator('.tree-label').filter({ hasText: '原子目录' })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: `收起 ${folder.title}`, exact: true }),
  ).toBeVisible();
  await expect(page.locator('.tree .inline-error')).toHaveCount(0);
  await expect(refresh).toBeEnabled();
  expect(secondPages).toBe(2);
  const box = await refresh.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: `.wrangler/directory-refresh-${info.project.name}.png` });
});

test('a late load-more response cannot overwrite a refreshed branch', async ({ page }, info) => {
  await login(page);
  const folder = await create(page, { kind: 'folder', title: `并发目录 ${info.project.name}` });
  // Only folders with children show an expand arrow; the listing below is mocked.
  await create(page, { kind: 'markdown', title: '占位', parentId: folder.id });
  let latest = false;
  let release: (() => void) | undefined;
  let completed: Promise<void> | undefined;
  await page.route(`**/api/nodes?parent=${folder.id}*`, async (route) => {
    if (new URL(route.request().url()).searchParams.has('offset')) {
      let done: () => void;
      completed = new Promise<void>((resolve) => {
        done = resolve;
      });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({
        json: {
          nodes: [{ ...folder, id: `${folder.id}-late`, title: '已删除的旧条目' }],
          nextOffset: null,
        },
      });
      done!();
      return;
    }
    await route.fulfill({
      json: {
        nodes: [
          { ...folder, id: `${folder.id}-one`, title: latest ? '刷新后的条目' : '刷新前的条目' },
        ],
        nextOffset: latest ? null : 1,
      },
    });
  });
  await page.goto('/');
  await openSidebar(page);
  await page
    .locator('.tree')
    .getByRole('button', { name: `展开 ${folder.title}`, exact: true })
    .click();
  await page.locator('.tree').getByRole('button', { name: '加载更多', exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  latest = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.tree-label').filter({ hasText: '刷新后的条目' })).toBeVisible();
  release!();
  await completed;
  // Let the released response cross the cache and React boundaries before asserting.
  await page.waitForTimeout(200);
  await expect(page.locator('.tree-label').filter({ hasText: '已删除的旧条目' })).toHaveCount(0);
  await expect(page.locator('.tree-label').filter({ hasText: '刷新后的条目' })).toBeVisible();
  await expect(
    page.locator('.tree').getByRole('button', { name: '加载更多', exact: true }),
  ).toHaveCount(0);
});

test('offline refresh retains the directory and reconnect picks up changes', async ({
  page,
  context,
}, info) => {
  await login(page);
  const folder = await create(page, { kind: 'folder', title: `断网前 ${info.project.name}` });
  await page.goto('/');
  await openSidebar(page);
  await expect(page.locator('.tree-label').filter({ hasText: folder.title })).toBeVisible();
  await context.setOffline(true);
  await expect(page.locator('.tree-offline')).toHaveText('离线目录');
  await page.getByRole('button', { name: '刷新目录', exact: true }).click();
  await expect(page.locator('.tree-refresh-error')).toContainText('暂时无法刷新');
  await expect(page.locator('.tree-label').filter({ hasText: folder.title })).toBeVisible();
  await page.request.patch(`/api/nodes/${folder.id}`, {
    headers,
    data: { revision: folder.revision, title: `重新连上 ${info.project.name}` },
  });
  await context.setOffline(false);
  await expect(
    page.locator('.tree-label').filter({ hasText: `重新连上 ${info.project.name}` }),
  ).toBeVisible();
  await expect(page.locator('.tree-offline')).toHaveCount(0);
  await expect(page.locator('.tree-refresh-error')).toHaveCount(0);
});

test('directory refresh leaves an unsaved editor and current note intact', async ({
  page,
}, info) => {
  await login(page);
  const note = await create(page, {
    kind: 'markdown',
    title: `编辑中的笔记 ${info.project.name}`,
    content: '已保存的正文',
  });
  await page.goto(`/n/${note.id}`);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Markdown 源码' });
  await editor.fill('还没有保存的修改');
  await openSidebar(page);
  const folder = await create(page, { kind: 'folder', title: `编辑时新增 ${info.project.name}` });
  await page.getByRole('button', { name: '刷新目录', exact: true }).click();
  await expect(page.locator('.tree-label').filter({ hasText: folder.title })).toBeVisible();
  const refreshed = page.waitForResponse((response) =>
    response.url().endsWith('/api/nodes?parent='),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await refreshed;
  await expect(page.getByRole('button', { name: '刷新目录', exact: true })).toBeEnabled();
  if (info.project.name === 'mobile')
    await page.getByRole('button', { name: '关闭侧栏', exact: true }).click();
  await expect(editor).toHaveText('还没有保存的修改');
  await expect(page).toHaveURL(new RegExp(`/n/${note.id}$`));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await (await page.request.get(`/api/nodes/${note.id}`)).json()).content).toBe(
    '已保存的正文',
  );
});
