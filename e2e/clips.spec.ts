import { editorAction, noteAction } from './note-actions';
import { test, expect, type Page } from './fixtures';

const headers = { origin: 'http://127.0.0.1:8799' };
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
async function login(page: Page) {
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
}

test('随手记 keeps, copies, pins and deletes clips from any page', async ({ page, context }, testInfo) => {
  test.setTimeout(90_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  await login(page);
  const note = await (
    await page.request.post('/api/nodes', {
      headers,
      data: { kind: 'markdown', title: '读书摘录', content: '# 读书摘录\n\n落笔于页，留心于间。' },
    })
  ).json();

  // From the home page header.
  await page.locator('.app-header').getByRole('button', { name: '随手记' }).click();
  let dialog = page.getByRole('dialog', { name: '随手记' });
  await expect(dialog.getByText('还没有随手记。')).toBeVisible();
  await dialog.getByLabel('随手记内容').fill('第一条：买书');
  await dialog.getByLabel('随手记内容').press('ControlOrMeta+Enter');
  await expect(dialog.locator('.clip-item').first()).toContainText('第一条：买书');
  await expect(dialog.getByText('正在保存')).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭' }).click();

  // From a note page, with the note as its source.
  await page.goto(`/n/${note.id}`);
  await expect(page.locator('.read-content')).toContainText('落笔于页');
  await noteAction(page, '随手记');
  dialog = page.getByRole('dialog', { name: '随手记' });
  await dialog.getByLabel('随手记内容').fill('第二条：从笔记里记下');
  await dialog.getByLabel('附上来源「读书摘录」').check();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  const second = dialog.locator('.clip-item').filter({ hasText: '第二条' });
  await expect(second.getByRole('button', { name: '读书摘录' })).toBeVisible();
  await expect(dialog.locator('.clip-item').first()).toContainText('第二条');

  // Pinning moves the older one to the top group.
  await dialog.locator('.clip-item').filter({ hasText: '第一条' }).getByRole('button', { name: '置顶' }).click();
  await expect(dialog.getByRole('region', { name: '置顶' })).toContainText('第一条：买书');
  for (const theme of ['light', 'dark', 'starry']) {
    await page.evaluate((value) => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'note:theme', newValue: value }));
    }, theme);
    await page.screenshot({ path: testInfo.outputPath(`clips-${theme}.png`) });
  }

  // Reading a clip is passive; copying is an explicit action.
  await dialog.locator('.clip-text').filter({ hasText: '第二条' }).click();
  await expect(dialog.getByText('已复制')).toHaveCount(0);
  await dialog.locator('.clip-item').filter({ hasText: '第二条' }).getByRole('button', { name: '复制文字', exact: true }).click();
  await expect(dialog.getByText('已复制')).toBeVisible();
  if (testInfo.project.name === 'desktop')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('第二条：从笔记里记下');

  // Delete, then undo.
  await second.getByRole('button', { name: '删除' }).click();
  await expect(dialog.locator('.clip-item').filter({ hasText: '第二条' })).toHaveCount(0);
  await dialog.getByRole('button', { name: '撤销' }).click();
  await expect(dialog.locator('.clip-item').filter({ hasText: '第二条' })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // A selection can be saved from the overflow menu.
  await page.locator('.read-content p').filter({ hasText: '落笔于页' }).selectText();
  await page.locator('.selection-toolbar').getByRole('button', { name: '更多', exact: true }).click();
  await page.locator('.selection-toolbar').getByRole('menuitem', { name: '记一下' }).click();
  await expect(page.locator('.selection-toolbar')).toContainText('已存入随手记');
  await page.screenshot({ path: testInfo.outputPath('selection-toolbar.png') });
  if (testInfo.project.name === 'desktop') {
    await page.locator('.read-content').click();
    await page.keyboard.press('q');
  } else await noteAction(page, '随手记');
  dialog = page.getByRole('dialog', { name: '随手记' });
  await expect(
    dialog.getByRole('region', { name: '最近' }).locator('.clip-item').first(),
  ).toContainText('落笔于页，留心于间。');
});

test('随手记 images go into the note being edited and become notes; clips can be encrypted', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await login(page);
  const note = await (
    await page.request.post('/api/nodes', {
      headers,
      data: { kind: 'markdown', title: '草稿', content: '开头' },
    })
  ).json();
  await page.locator('.app-header').getByRole('button', { name: '随手记' }).click();
  let dialog = page.getByRole('dialog', { name: '随手记' });
  await dialog.getByLabel('添加图片').setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });
  await expect(dialog.locator('.clips-image-draft img')).toBeVisible();
  await dialog.getByLabel('随手记内容').fill('图配文');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  const imageClip = dialog.locator('.clip-item').filter({ hasText: '图配文' });
  await expect(imageClip.locator('.clip-image img')).toHaveAttribute('src', /^blob:/);
  await expect(dialog.getByText('正在保存')).toHaveCount(0);
  await dialog.getByLabel('随手记内容').fill('插入用的一句话');
  await dialog.getByLabel('随手记内容').press('ControlOrMeta+Enter');
  await expect(dialog.locator('.clip-item').first()).toContainText('插入用的一句话');
  await expect(dialog.getByText('正在保存')).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭' }).click();

  // Into the note being edited, at the cursor.
  await page.goto(`/n/${note.id}`);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown 源码' });
  await expect(source).toBeVisible();
  await source.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await editorAction(page, '插入随手记');
  dialog = page.getByRole('dialog', { name: '随手记' });
  await expect(dialog.getByText('插入位置：「草稿」的光标处')).toBeVisible();
  await dialog
    .locator('.clip-item')
    .filter({ hasText: '插入用的一句话' })
    .getByRole('button', { name: '插入到正文' })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(source).toContainText('插入用的一句话');
  await editorAction(page, '插入随手记');
  await dialog
    .locator('.clip-item')
    .filter({ hasText: '图配文' })
    .getByRole('button', { name: '插入到正文' })
    .click();
  await expect(source).toContainText('![dot.png](/api/files/');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.read-content img')).toBeVisible();

  // An image clip becomes a note of its own, and leaves 随手记.
  await noteAction(page, '随手记');
  await dialog
    .locator('.clip-item')
    .filter({ hasText: '图配文' })
    .getByRole('button', { name: '转为笔记' })
    .click();
  await expect(dialog.getByLabel('标题')).toHaveValue('图配文');
  await dialog.getByRole('button', { name: '转为笔记', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.document-heading h1, h1').first()).toContainText('图配文');
  await expect(page.locator('.read-content img')).toBeVisible();
  await expect(page.locator('.read-content')).toContainText('图配文');

  // Encrypt: existing clips are re-sealed here and still read back.
  await noteAction(page, '随手记');
  await expect(dialog.locator('.clip-item').filter({ hasText: '图配文' })).toHaveCount(0);
  await dialog.getByRole('button', { name: '加密设置' }).click();
  await dialog.getByLabel('密码', { exact: true }).fill('clip-secret');
  await dialog.getByLabel('再次输入').fill('clip-secret');
  await dialog.getByRole('button', { name: '设置密码' }).click();
  await expect(dialog.getByRole('button', { name: '加密设置（已加密）' })).toBeVisible();
  await expect(dialog.locator('.clip-item').first()).toContainText('插入用的一句话');
  const stored = await (await page.request.get('/api/clips')).json();
  expect(stored.keyId).toBeTruthy();
  expect(stored.items.every((clip: { text: string }) => clip.text.startsWith('⁣xve1:'))).toBe(true);
  await dialog.getByLabel('随手记内容').fill('加密后的新条目');
  await dialog.getByLabel('随手记内容').press('ControlOrMeta+Enter');
  await expect(dialog.locator('.clip-item').first()).toContainText('加密后的新条目');
  for (const theme of ['light', 'dark', 'starry']) {
    await page.evaluate((value) => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'note:theme', newValue: value }));
    }, theme);
    await page.screenshot({ path: testInfo.outputPath(`encrypted-${theme}.png`) });
  }
  // Change the password, then turn encryption off again.
  await dialog.getByRole('button', { name: '加密设置' }).click();
  await dialog.getByRole('button', { name: '修改密码' }).click();
  await dialog.getByLabel('新密码').fill('clip-secret-2');
  await dialog.getByLabel('再次输入').fill('clip-secret-2');
  await dialog.getByRole('button', { name: '修改密码' }).click();
  await expect(dialog.getByLabel('随手记内容')).toBeVisible();
  await dialog.getByRole('button', { name: '加密设置' }).click();
  await dialog.getByRole('button', { name: '取消加密' }).click();
  await expect(dialog.getByRole('button', { name: '加密设置（未加密）' })).toBeVisible();
  const plain = await (await page.request.get('/api/clips')).json();
  expect(plain.items.map((clip: { text: string }) => clip.text)).toEqual([
    '加密后的新条目',
    '插入用的一句话',
  ]);
});

test('随手记 archives, searches and restores from the header entry', async ({ page }) => {
  await login(page);
  await page.request.post('/api/clips', { headers, data: { id: 'archive-e2e', text: '已整理的读书想法' } });
  await page.locator('.app-header').getByRole('button', { name: '随手记' }).click();
  const active = page.getByRole('dialog', { name: '随手记', exact: true });
  await expect(active.getByText('已整理的读书想法')).toBeVisible();
  await active.getByRole('button', { name: '归档', exact: true }).click();
  await expect(active.getByText('已整理的读书想法')).toHaveCount(0);
  await active.getByRole('button', { name: '已归档', exact: true }).click();
  const archive = page.getByRole('dialog', { name: '已归档', exact: true });
  await expect(archive.getByText('已整理的读书想法')).toBeVisible();
  await archive.getByRole('textbox', { name: '搜索已归档' }).fill('读书');
  await expect(archive.getByText('已整理的读书想法')).toBeVisible();
  await archive.getByRole('button', { name: '恢复随手记' }).click();
  await expect(archive.getByText('已恢复到随手记')).toBeVisible();
  await archive.getByRole('button', { name: '返回随手记' }).click();
  await expect(active.getByText('已整理的读书想法')).toBeVisible();
});
