import { expect, test } from '@playwright/test';
import { preparePassword } from '../shared/password';

test('Android home tree replaces the sidebar and restores nested pages after reading', async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    (window as any).androidBridge = {};
  });
  const headers = { origin: 'http://127.0.0.1:8799' };
  const status = await (await page.request.get('/api/auth/status')).json();
  const login = await page.request.post(`/api/auth/${status.initialized ? 'login' : 'setup'}`, {
    headers,
    data: {
      password: await preparePassword('Note2026', status.initialized ? status.password : undefined),
      ...(!status.initialized ? { token: 'e2e-test-only-setup-token-never-deploy-0001' } : {}),
    },
  });
  expect(login.ok()).toBeTruthy();
  const create = async (data: object) => {
    const result = await page.request.post('/api/nodes', { headers, data });
    expect(result.ok()).toBeTruthy();
    return result.json();
  };
  const root = await create({ kind: 'folder', title: `目录 ${info.project.name}` });
  const inner = await create({ kind: 'folder', title: '内层目录', parentId: root.id });
  const note = await create({ kind: 'markdown', title: '底部笔记', parentId: inner.id });
  let title = root.title;
  await page.route('**/api/nodes?parent=*', async (route) => {
    const url = new URL(route.request().url());
    const parent = url.searchParams.get('parent');
    const second = url.searchParams.has('offset');
    const nodes =
      parent === ''
        ? [{ ...root, title }]
        : parent === root.id
          ? [inner]
          : parent === inner.id
            ? second
              ? [note]
              : Array.from({ length: 25 }, (_, i) => ({
                  ...note,
                  id: `mock-${i}`,
                  title: `条目 ${i}`,
                }))
            : [];
    await route.fulfill({
      json: { nodes, nextOffset: parent === inner.id && !second ? 25 : null },
    });
  });
  await page.goto('/');
  await expect(page.locator('#notebook-sidebar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '打开笔记目录', exact: true })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '底部导航' })).toBeVisible();
  await page.getByRole('button', { name: `展开 ${root.title}`, exact: true }).click();
  await page.getByRole('button', { name: '展开 内层目录', exact: true }).click();
  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  const target = page.getByRole('button', { name: note.title, exact: true });
  await target.scrollIntoViewIfNeeded();
  const before = await page.locator('.main-content').evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThan(500);
  await target.click();
  await expect(page.locator('.document-heading h1')).toHaveText(note.title);
  await expect(page.getByRole('button', { name: '打开笔记目录', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect(target).toBeInViewport();
  await expect
    .poll(() => page.locator('.main-content').evaluate((el) => el.scrollTop))
    .toBeCloseTo(before, 0);
  title = '刷新后的目录';
  await expect(page.getByRole('button', { name: '刷新目录', exact: true })).toHaveCount(0);
  await page.locator('.main-content').evaluate((el) => {
    el.scrollTop = 0;
    const touch = (y: number) => new Touch({ identifier: 1, target: el, clientX: 100, clientY: y });
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(100)], bubbles: true }));
    el.dispatchEvent(
      new TouchEvent('touchmove', { touches: [touch(260)], bubbles: true, cancelable: true }),
    );
    el.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true }));
  });
  await expect(page.getByRole('button', { name: title, exact: true })).toBeAttached();
  await expect(target).toBeAttached();
  await page.locator('.main-content').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.getByRole('button', { name: `管理 ${title}`, exact: true }).click();
  await expect(page.getByRole('button', { name: '移动到…', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page
    .locator('.phone-bottom-nav')
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await page.getByRole('button', { name: '外观', exact: true }).click();
  for (const name of ['白天', '夜间', '星空']) {
    await page.getByRole('radio', { name, exact: true }).check();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page
      .locator('.phone-bottom-nav')
      .getByRole('button', { name: '笔记', exact: true })
      .click();
    await expect(page.getByRole('button', { name: '收起 内层目录', exact: true })).toBeVisible();
    await page.screenshot({ path: `test-results/android-home-${name}-${info.project.name}.png` });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
    await page
      .locator('.phone-bottom-nav')
      .getByRole('button', { name: '设置', exact: true })
      .click();
    await page.getByRole('button', { name: '外观', exact: true }).click();
  }
});

test('Android favorites refresh only after a deliberate pull from the top', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).androidBridge = {};
  });
  const headers = { origin: 'http://127.0.0.1:8799' };
  const status = await (await page.request.get('/api/auth/status')).json();
  const response = await page.request.post(`/api/auth/${status.initialized ? 'login' : 'setup'}`, {
    headers,
    data: {
      password: await preparePassword('Note2026', status.initialized ? status.password : undefined),
      ...(!status.initialized ? { token: 'e2e-test-only-setup-token-never-deploy-0001' } : {}),
    },
  });
  expect(response.ok()).toBeTruthy();
  let requests = 0;
  await page.route('**/api/nodes?view=favorites*', async (route) => {
    requests++;
    await route.fulfill({ json: { nodes: [], nextOffset: null } });
  });
  await page.goto('/favorites');
  await expect(page.locator('.phone-bottom-nav')).toBeVisible();
  await expect.poll(() => requests).toBe(1);
  const pull = async (distance: number, cancel = false) => {
    await page.locator('.main-content').evaluate(
      (el, { distance, cancel }) => {
        const touch = (y: number) =>
          new Touch({ identifier: 1, target: el, clientX: 100, clientY: y });
        el.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(100)], bubbles: true }));
        el.dispatchEvent(
          new TouchEvent('touchmove', {
            touches: [touch(100 + distance)],
            bubbles: true,
            cancelable: true,
          }),
        );
        el.dispatchEvent(
          new TouchEvent(cancel ? 'touchcancel' : 'touchend', { touches: [], bubbles: true }),
        );
      },
      { distance, cancel },
    );
  };
  await pull(30);
  await pull(180, true);
  expect(requests).toBe(1);
  await pull(180);
  await expect.poll(() => requests).toBe(2);
  await expect(page.locator('.pull-refresh')).toHaveCount(0);
  const height = await page
    .locator('.phone-bottom-nav')
    .evaluate((el) => el.getBoundingClientRect().height);
  expect(height).toBeLessThanOrEqual(56);
});
