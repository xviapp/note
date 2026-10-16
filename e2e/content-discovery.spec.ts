import { test, expect, type Page } from './fixtures';
import { login } from './notebook-helpers';

const headers = { origin: 'http://127.0.0.1:8799' };
async function create(page: Page, data: object) {
  const response = await page.request.post('/api/nodes', { headers, data });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

for (const android of [false, true]) test(`lists summarize content, sort and retain compact mode${android ? ' on Android' : ''}`, async ({ page }, info) => {
  if (android) await page.addInitScript(() => { (window as any).androidBridge = {}; });
  await login(page);
  await create(page, { kind: 'markdown', title: 'B 阅读札记', content: '# 记录\n\n一句能帮助识别内容的摘要。' });
  const folder = await create(page, { kind: 'folder', title: 'A 资料' });
  await create(page, { kind: 'markdown', title: '下级笔记', parentId: folder.id });
  await create(page, { kind: 'folder', title: 'C 书籍', book: { pageCount: 100, pagesRead: 12 } });
  await page.goto('/');
  const root = page.locator('.library-home');
  const rows = root.locator(android ? '.tree-label' : '.node-list-main');
  await expect(rows.filter({ hasText: 'B 阅读札记' })).toContainText('一句能帮助识别内容的摘要');
  await expect(rows.filter({ hasText: 'A 资料' })).toContainText('1 个下级条目');
  await expect(rows.filter({ hasText: 'C 书籍' })).toContainText('读到第 12 页 / 共 100 页');
  await root.getByLabel('列表排序').selectOption('title');
  await expect(rows.first()).toContainText('A 资料');
  await root.getByRole('button', { name: '紧凑列表', exact: true }).click();
  await expect(rows.filter({ hasText: 'B 阅读札记' }).locator('small')).toBeHidden();
  await page.reload();
  await expect(root.getByLabel('列表排序')).toHaveValue('title');
  await expect(root.getByRole('button', { name: '紧凑列表', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await root.getByRole('button', { name: '紧凑列表', exact: true }).click();
  // The browser-only Android stub has no native NoteDevice plugin.
  if (android) {
    const notice = page.locator('.notice').filter({ hasText: 'NoteDevice' });
    if (await notice.isVisible()) await notice.getByRole('button', { name: '关闭提示' }).click();
  }
  for (const theme of ['light', 'dark', 'starry']) {
    await page.evaluate((value) => window.dispatchEvent(new StorageEvent('storage', { key: 'note:theme', newValue: value })), theme);
    await page.screenshot({ path: info.outputPath(`list-${android ? 'android' : 'web'}-${theme}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  }
  if (info.project.name === 'mobile') {
    await page.setViewportSize({ width: 320, height: 740 });
    await expect(root.getByLabel('列表排序')).toBeVisible();
    await page.screenshot({ path: info.outputPath('list-320.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  }
});

test('search narrows the current directory and types while retaining relevance ranking', async ({ page }, info) => {
  await login(page);
  const folder = await create(page, { kind: 'folder', title: '当前资料' });
  const nested = await create(page, { kind: 'folder', title: '子目录', parentId: folder.id });
  await create(page, { kind: 'markdown', title: '线索', parentId: nested.id });
  await create(page, { kind: 'markdown', title: '线索 外部' });
  await create(page, { kind: 'folder', title: '线索 书籍', parentId: folder.id, book: {} });
  await page.goto(`/n/${folder.id}`);
  await expect(page.locator('.document-heading h1')).toHaveText(folder.title);
  if (info.project.name === 'mobile') await page.getByRole('button', { name: '打开笔记目录', exact: true }).click();
  await page.locator('.sidebar-search').click();
  const dialog = page.getByRole('dialog', { name: '搜索笔记', exact: true });
  await dialog.getByRole('combobox', { name: '搜索笔记标题、正文或批注' }).fill('线索');
  await expect(dialog.getByRole('listbox', { name: '搜索结果' }).getByRole('option').first()).toHaveText('线索当前资料 / 子目录');
  await dialog.getByLabel('搜索范围').selectOption('current');
  await expect(dialog.getByRole('listbox', { name: '搜索结果' }).getByRole('option')).toHaveCount(2);
  await dialog.getByLabel('搜索类型').selectOption('book');
  await expect(dialog.getByRole('listbox', { name: '搜索结果' }).getByRole('option')).toHaveCount(1);
  await expect(dialog.getByRole('listbox', { name: '搜索结果' }).getByRole('option')).toContainText('线索 书籍');
  await dialog.getByLabel('搜索排序').selectOption('updated');
  await expect(dialog.locator('.search-caption')).toHaveText('找到 1 项');
  for (const theme of ['light', 'dark', 'starry']) {
    await page.evaluate((value) => window.dispatchEvent(new StorageEvent('storage', { key: 'note:theme', newValue: value })), theme);
    await page.screenshot({ path: info.outputPath(`search-${theme}.png`) });
  }
  if (info.project.name === 'mobile') {
    await page.setViewportSize({ width: 320, height: 740 });
    await expect(dialog.getByLabel('搜索范围')).toBeVisible();
    await page.screenshot({ path: info.outputPath('search-320.png') });
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBeTruthy();
  }
  await dialog.getByLabel('搜索类型').selectOption('note');
  await expect(dialog.getByRole('listbox', { name: '搜索结果' }).getByRole('option')).toHaveCount(1);
  await dialog.getByRole('listbox', { name: '搜索结果' }).getByRole('option').click();
  await expect(page.locator('.document-heading h1')).toHaveText('线索');
});

test('Qingli distinguishes the next turn materials and retains source navigation after reopening', async ({ page }, info) => {
  await login(page);
  await page.request.put('/api/ai/settings', { headers, data: { apiKey: 'sk-e2e-placeholder-key' } });
  const filler = Array.from({ length: 30 }, () => '阅读时记录自己的想法。').join('\n\n');
  const node = await create(page, { kind: 'markdown', title: '引用来源', content: `# 阅读\n\n${filler}\n\n这段原文值得认真讨论。` });
  await page.goto(`/n/${node.id}`);
  await page.getByRole('button', { name: '打开青藜', exact: true }).click();
  const panel = page.getByRole('complementary', { name: '青藜', exact: true });
  await expect(panel.locator('.assistant-materials')).toContainText('未附正文');
  if (info.project.name === 'mobile') await panel.getByRole('button', { name: '青藜全屏', exact: true }).click();
  await panel.getByRole('button', { name: '附上当前文件', exact: true }).click();
  await page.getByRole('dialog', { name: '附上文件', exact: true }).getByRole('button', { name: '附到对话', exact: true }).click();
  await expect(panel.locator('.assistant-materials')).toContainText('已附全文');
  await panel.getByRole('textbox', { name: '发给青藜的问题', exact: true }).fill('帮我解释这段内容');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect(panel.locator('.chat-assistant')).toContainText('先回答');
  await page.reload();
  await page.getByRole('button', { name: '打开青藜', exact: true }).click();
  await panel.locator('.chat-file-card > summary').click();
  await expect(panel.locator('.chat-file-card').getByRole('button', { name: '返回原文', exact: true })).toBeVisible();
  for (const theme of ['light', 'dark', 'starry']) {
    await page.evaluate((value) => window.dispatchEvent(new StorageEvent('storage', { key: 'note:theme', newValue: value })), theme);
    await page.screenshot({ path: info.outputPath(`sources-${theme}.png`) });
  }
  await panel.locator('.chat-file-card').getByRole('button', { name: '返回原文', exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/n/${node.id}$`));
  const target = page.locator('.read-content p').filter({ hasText: '这段原文值得认真讨论。' });
  await page.locator('.note-scroll').press('End');
  await target.scrollIntoViewIfNeeded();
  await target.selectText();
  await page.locator('.selection-toolbar').getByRole('button', { name: '问青藜', exact: true }).click();
  await expect(panel.locator('.assistant-materials')).toContainText('已附选文');
  await page.locator('.note-scroll').evaluate((element) => { element.scrollTop = 0; });
  await panel.locator('.context-quote').getByRole('button', { name: '返回原文', exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(target).toBeInViewport();
});
