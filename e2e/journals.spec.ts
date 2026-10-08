import { test, expect } from './fixtures';

test('journal calendar and quick append work in all themes', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const status = await (await page.request.get('/api/auth/status')).json();
  await page.goto(status.initialized ? '/' : '/#setup=e2e-test-only-setup-token-never-deploy-0001');
  if (!status.initialized) {
    await page.getByLabel('设置密码', { exact: true }).fill('Note2026');
    await page.getByLabel('确认密码', { exact: true }).fill('Note2026');
    await page.getByRole('button', { name: '创建笔记库' }).click();
  } else {
    await page.getByLabel('密码', { exact: true }).fill('Note2026');
    await page.getByRole('button', { name: '打开笔记库' }).click();
  }
  await expect(page.locator('.app-shell')).toBeVisible();
  const headers = { origin: 'http://127.0.0.1:8799' };
  const created = await page.request.post('/api/nodes', {
    headers, data: { kind: 'folder', title: '日常记录', journal: true },
  });
  expect(created.ok()).toBe(true);
  await page.reload();
  await page.locator('.node-list-main').filter({ hasText: '日常记录' }).click();
  await expect(page.getByRole('combobox', { name: '模板', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '管理模板', exact: true })).toHaveCount(0);
  for (const theme of ['light', 'dark', 'starry']) {
    await page.evaluate((value) => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'note:theme', newValue: value }));
    }, theme);
    const header = await page.locator('.document-title-row').evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const title = element.querySelector('h1')!.getBoundingClientRect();
      const create = element.querySelector('.primary')!.getBoundingClientRect();
      return { rightGap: Math.abs(bounds.right - create.right), centerGap: Math.abs(title.y + title.height / 2 - create.y - create.height / 2) };
    });
    expect(header.rightGap).toBeLessThan(2);
    expect(header.centerGap).toBeLessThan(2);
    await expect(page.locator('.journal-panel').getByRole('button', { name: '新建', exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`calendar-${theme}.png`) });
  }
  await page.locator('.document-title-row').getByRole('button', { name: '写今天', exact: true }).click();
  const journalId = (await created.json()).id;
  const entries = async () => (await (await page.request.get(`/api/nodes/${journalId}/journal?month=${new Date().toISOString().slice(0, 7)}`)).json()).entries;
  expect(await entries()).toHaveLength(0);
  await page.getByRole('button', { name: '返回日历', exact: true }).click();
  await expect(page.locator('.journal-calendar .has-entry')).toHaveCount(0);
  await page.locator('.journal-calendar .is-today').click();
  await page.getByLabel('记录内容').fill('待创建的草稿');
  await page.getByRole('button', { name: '返回日历', exact: true }).click();
  expect(await entries()).toHaveLength(0);
  await page.reload();
  await expect(page.locator('.journal-calendar .is-today.has-draft')).toHaveAttribute('aria-label', /有未提交的记录/);
  await page.locator('.journal-calendar .is-today').click();
  await expect(page.getByLabel('记录内容')).toHaveValue('待创建的草稿');
  await expect(page.getByRole('form', { name: '快捷记录' })).toBeVisible();
  await expect(page.locator('.assistant-launcher:visible')).toHaveCount(1);
  const layout = await page.locator('.quick-append-footer').evaluate((element) => {
    const form = element.querySelector('.quick-append')!.getBoundingClientRect();
    const footer = element.getBoundingClientRect();
    const title = element.querySelector('input')!.getBoundingClientRect();
    const text = element.querySelector('textarea')!.getBoundingClientRect();
    const body = element.closest('.note-reading-column')!.querySelector('.read-content')!.getBoundingClientRect();
    return { width: form.width, footerWidth: footer.width, center: Math.abs(form.x + form.width / 2 - body.x - body.width / 2), equalWidth: Math.abs(title.width - text.width), height: text.height };
  });
  expect(Math.round(layout.width)).toBeLessThanOrEqual(720);
  expect(layout.width).toBeLessThan(layout.footerWidth - 20);
  expect(layout.center).toBeLessThan(2);
  if (testInfo.project.name === 'desktop') {
    expect(layout.equalWidth).toBeLessThan(1);
    expect(layout.height).toBeGreaterThanOrEqual(104);
  } else expect(layout.height).toBeGreaterThanOrEqual(64);
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await expect(page.locator('.document-meta').getByRole('button', { name: '新建', exact: true })).toHaveCount(0);
  await page.getByLabel('记录标题').fill('傍晚');
  await page.getByLabel('记录内容').fill('散步回家，路上看到一只猫。');
  await page.route('**/api/nodes/*/journal/entries', (route) => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: '保存暂时失败，请重试。' }),
  }), { times: 1 });
  await page.getByRole('button', { name: '追加', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('保存暂时失败');
  await expect(page.getByLabel('记录内容')).toHaveValue('散步回家，路上看到一只猫。');
  expect(await entries()).toHaveLength(0);
  await page.getByRole('button', { name: '重试追加', exact: true }).click();
  await expect(page.locator('.records-journal section.record .record-title')).toHaveText('傍晚');
  await expect(page.locator('.records-journal section.record .record-time')).toHaveText(/^\d{2}:\d{2}$/);
  expect(await entries()).toHaveLength(1);
  await expect(page.getByLabel('记录内容')).toHaveValue('');
  await page.getByLabel('记录内容').fill('第二条随手记');
  await page.getByLabel('记录内容').press('Control+Enter');
  await expect(page.getByText('第二条随手记', { exact: true })).toBeVisible();
  // Input survives reopening; it is separate from the full editor's draft.
  await page.getByLabel('记录内容').fill('待追加的草稿');
  await page.reload();
  await expect(page.getByLabel('记录内容')).toHaveValue('待追加的草稿');
  await expect(page.getByRole('button', { name: '追加', exact: true })).toBeEnabled();
  for (const theme of ['light', 'dark', 'starry']) {
    await page.evaluate((value) => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'note:theme', newValue: value }));
    }, theme);
    await expect(page.getByRole('button', { name: '追加', exact: true })).toBeInViewport();
    await expect(page.getByLabel('记录内容')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`journal-${theme}.png`) });
  }
  await page.getByRole('button', { name: '返回', exact: true }).click();
  // Another device can create the day while its first record is still a local draft.
  await page.getByRole('button', { name: '返回', exact: true }).click();
  const yesterday = await page.evaluate(() => {
    const date = new Date();
    date.setDate(date.getDate() - 1);
    return { date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`, previousMonth: new Date().getDate() === 1 };
  });
  if (yesterday.previousMonth) await page.getByRole('button', { name: '上个月', exact: true }).click();
  const day = page.locator('.journal-calendar button').filter({ hasText: new RegExp(`^${Number(yesterday.date.slice(8))}$`) });
  await day.click();
  await page.getByLabel('记录内容').fill('本设备的补充');
  const concurrent = await page.request.post(`/api/nodes/${journalId}/journal/entries`, {
    headers, data: { date: yesterday.date, content: '其他设备先写的内容' },
  });
  expect(concurrent.ok()).toBe(true);
  const entryId = (await concurrent.json()).node.id;
  await page.route(`**/api/nodes/${entryId}/content`, async (route) => {
    await route.fetch();
    await route.abort('connectionfailed');
  }, { times: 1 });
  await page.getByRole('button', { name: '追加', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.reload();
  if (yesterday.previousMonth) await page.getByRole('button', { name: '上个月', exact: true }).click();
  await day.click();
  await page.getByRole('button', { name: '重试追加', exact: true }).click();
  await expect(page.getByText('其他设备先写的内容', { exact: true })).toBeVisible();
  await expect(page.getByText('本设备的补充', { exact: true })).toHaveCount(1);
  const persisted = await (await page.request.get(`/api/nodes/${entryId}`)).json();
  expect(persisted.content.split('本设备的补充')).toHaveLength(2);

});
