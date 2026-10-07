import { test, expect } from './fixtures';

test('journal templates and quick append work in all themes', async ({ page }, testInfo) => {
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
  await expect(page.getByRole('combobox', { name: '模板', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '管理模板', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '日记模板', exact: true });
  await dialog.getByRole('button', { name: '新建模板', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '新建模板', exact: true });
  await dialog.getByLabel('模板名称').fill('每日回顾');
  const editor = dialog.getByRole('textbox', { name: 'Markdown 源码' });
  await editor.press('ControlOrMeta+a');
  await editor.press('Backspace');
  await editor.fill('# {{日期}} {{星期}}\n\n今天值得记住的事');
  for (const theme of ['light', 'dark', 'starry']) {
    await page.evaluate((value) => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'note:theme', newValue: value }));
    }, theme);
    await page.screenshot({ path: testInfo.outputPath(`template-editor-${theme}.png`) });
  }
  await dialog.getByRole('button', { name: '预览今天' }).click();
  await expect(dialog.getByText('今天值得记住的事', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '保存模板', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '日记模板', exact: true });
  await expect(dialog.getByText('每日回顾', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '编辑', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '编辑模板', exact: true });
  await dialog.getByLabel('模板名称').fill('日常回顾');
  const editSource = dialog.getByRole('textbox', { name: 'Markdown 源码' });
  await editSource.press('ControlOrMeta+a');
  await editSource.press('Backspace');
  await editSource.fill('# {{日期}} {{星期}}\n\n模板保留内容');
  await dialog.getByRole('button', { name: '保存模板', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '日记模板', exact: true });
  await expect(dialog.getByText('日常回顾', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '模板', exact: true })).toContainText('日常回顾');
  await page.getByRole('button', { name: '写今天的日记', exact: true }).click();
  await expect(page.getByRole('form', { name: '快捷记录' })).toBeVisible();
  await expect(page.locator('.assistant-launcher:visible')).toHaveCount(1);
  const layout = await page.locator('.quick-append-footer').evaluate((element) => {
    const form = element.querySelector('.quick-append')!.getBoundingClientRect();
    const footer = element.getBoundingClientRect();
    return { width: form.width, footerWidth: footer.width, center: Math.abs(form.x + form.width / 2 - footer.x - footer.width / 2) };
  });
  expect(Math.round(layout.width)).toBeLessThanOrEqual(720);
  expect(layout.width).toBeLessThan(layout.footerWidth - 48);
  expect(layout.center).toBeLessThan(2);
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await expect(page.locator('.document-meta').getByRole('button', { name: '新建', exact: true })).toHaveCount(0);
  await page.getByLabel('记录标题').fill('傍晚');
  await page.getByLabel('记录内容').fill('散步回家，路上看到一只猫。');
  await page.route('**/api/nodes/*/content', (route) => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: '保存暂时失败，请重试。' }),
  }), { times: 1 });
  await page.getByRole('button', { name: '追加', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('保存暂时失败');
  await expect(page.getByLabel('记录内容')).toHaveValue('散步回家，路上看到一只猫。');
  await page.getByRole('button', { name: '重试追加', exact: true }).click();
  await expect(page.getByRole('heading', { name: '傍晚', exact: true })).toBeVisible();
  await expect(page.getByText('模板保留内容', { exact: true })).toBeVisible();
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
  await page.getByRole('button', { name: '管理模板', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '日记模板', exact: true });
  for (const theme of ['light', 'dark', 'starry']) {
    await page.evaluate((value) => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'note:theme', newValue: value }));
    }, theme);
    await page.screenshot({ path: testInfo.outputPath(`templates-${theme}.png`) });
  }
  await dialog.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('dialog', { name: '删除模板？', exact: true }).getByRole('button', { name: '删除模板', exact: true }).click();
  await expect(dialog.getByText('日常回顾', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '模板', exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '打开今天的日记', exact: true }).click();
  await expect(page.getByText('模板保留内容', { exact: true })).toBeVisible();
});
