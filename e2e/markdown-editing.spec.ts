import { expect, test } from './fixtures';
import { login } from './notebook-helpers';
import { noteAction } from './note-actions';
import type { NoteDetail } from '../shared/types';

const headers = { origin: 'http://127.0.0.1:8799' };

test('ordinary Markdown can append, edit and delete sections in every theme', async ({ page }, info) => {
  await login(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const original = '---\ntitle: 阅读手记\n---\n\n开头的说明。\n\n## 第一节\n\n原来的内容。\n\n### 子章节\n\n子章节的内容。\n\n## 第二节\n\n需要保留。\n';
  const response = await page.request.post('/api/nodes', {
    headers, data: { kind: 'markdown', title: '快捷编辑.md', content: original },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const node = await response.json();
  const url = `/n/${node.id}`;
  await page.goto(url);
  await expect(page.locator('.read-content')).toContainText('原来的内容。');
  const readText = await page.locator('.read-content').textContent();
  await noteAction(page, '开启快捷编辑');
  await expect(page.getByRole('button', { name: '管理章节 第一节', exact: true })).toBeVisible();
  expect(await page.locator('.read-content').textContent()).toBe(readText);
  await page.reload();
  await expect(page.locator('.quick-append')).toBeVisible();

  // Turning the feature on for one note does not enable it on another note.
  const other = await (await page.request.post('/api/nodes', {
    headers, data: { kind: 'markdown', title: '其他笔记.md', content: '## 其他\n\n内容' },
  })).json();
  await page.goto(`/n/${other.id}`);
  await expect(page.locator('.read-content')).toContainText('其他');
  await expect(page.locator('.quick-append')).toHaveCount(0);
  await page.goto(url);

  const field = page.getByRole('textbox', { name: '章节 Markdown（含标题和子章节）' });
  for (const theme of ['light', 'dark', 'starry']) {
    await page.evaluate((value) => {
      localStorage.setItem('note:theme', value);
      window.dispatchEvent(new StorageEvent('storage', { key: 'note:theme', newValue: value }));
    }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.getByRole('button', { name: '管理章节 第一节', exact: true }).click();
    await expect(page.getByRole('button', { name: '编辑本节', exact: true })).toBeVisible();
    expect(await page.locator('.read-content').textContent()).toBe(readText);
    await page.screenshot({ path: info.outputPath(`sections-menu-${theme}.png`) });
    await page.getByRole('button', { name: '编辑本节', exact: true }).click();
    await expect(field).toHaveValue('## 第一节\n\n原来的内容。\n\n### 子章节\n\n子章节的内容。\n\n');
    await page.screenshot({ path: info.outputPath(`sections-editor-${theme}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const bounds = await field.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await page.getByRole('button', { name: '取消', exact: true }).click();
  }

  await page.getByRole('button', { name: '管理章节 第一节', exact: true }).click();
  await page.getByRole('button', { name: '编辑本节', exact: true }).click();
  await field.fill('## 修改标题\n\n修改后的内容。\n\n### 子章节\n\n子章节的内容。');
  await page.getByRole('button', { name: '保存本节', exact: true }).click();
  await expect(field).toHaveCount(0);
  await expect(page.locator('.read-content')).toContainText('修改后的内容。');
  const detail = async (): Promise<NoteDetail> => (await page.request.get(`/api/nodes/${node.id}`)).json();
  expect((await detail()).content).toBe(original.replace('## 第一节', '## 修改标题').replace('原来的内容。', '修改后的内容。'));

  await page.getByRole('textbox', { name: '记录内容' }).fill('新补充的正文。');
  await page.getByRole('textbox', { name: '记录标题' }).fill('新章节');
  await page.getByRole('button', { name: '追加笔记', exact: true }).click();
  await expect(page.locator('.read-content')).toContainText('新补充的正文。');
  expect((await detail()).content).toContain('## 新章节\n\n新补充的正文。');

  await page.getByRole('button', { name: '管理章节 修改标题', exact: true }).click();
  await page.getByRole('button', { name: '删除本节', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '删除这一节？' });
  await expect(confirmation).toContainText('包含 1 个子章节');
  await confirmation.getByRole('button', { name: '删除本节', exact: true }).click();
  await expect(page.locator('.section-editor')).toHaveCount(0);
  await expect(page.locator('.read-content')).not.toContainText('修改后的内容。');
  let afterDelete = await detail();
  expect(afterDelete.content).not.toContain('子章节');
  expect(afterDelete.content).toContain('开头的说明。\n\n## 第二节\n\n需要保留。');
  await noteAction(page, '版本历史');
  const history = page.getByRole('dialog', { name: '版本历史', exact: true });
  await expect(history.locator('.version-list > button')).toHaveCount(4);
  await history.getByRole('button', { name: /版本 3/ }).click();
  await expect(history.locator('.version-preview')).toContainText('子章节的内容。');
  await history.getByRole('button', { name: '恢复此版本', exact: true }).click();
  await page.getByRole('dialog', { name: '恢复这个版本？' }).getByRole('button', { name: '确认并恢复' }).click();
  await expect(page.locator('.read-content')).toContainText('子章节的内容。');
  await page.getByRole('button', { name: '管理章节 修改标题', exact: true }).click();
  await page.getByRole('button', { name: '删除本节', exact: true }).click();
  await confirmation.getByRole('button', { name: '删除本节', exact: true }).click();
  await expect(page.locator('.section-editor')).toHaveCount(0);
  await expect(page.locator('.read-content')).not.toContainText('子章节的内容。');
  afterDelete = await detail();

  // A save from another window must leave this section's input intact.
  await page.getByRole('button', { name: '管理章节 第二节', exact: true }).click();
  await page.getByRole('button', { name: '编辑本节', exact: true }).click();
  await field.fill('## 第二节\n\n本机尚未保存的修改。');
  const { token } = await (await page.request.post('/api/edit/unlock', { headers, data: { nodeId: node.id } })).json();
  const concurrent = await page.request.put(`/api/nodes/${node.id}/content`, {
    headers: { ...headers, 'x-note-edit': token },
    data: { revision: afterDelete.revision, content: afterDelete.content.replace('需要保留。', '其他页面的新内容。'), attachments: [] },
  });
  expect(concurrent.ok(), await concurrent.text()).toBe(true);
  await page.getByRole('button', { name: '保存本节', exact: true }).click();
  await expect(page.locator('.section-editor').getByRole('alert')).toContainText('修改已保留');
  await expect(field).toHaveValue('## 第二节\n\n本机尚未保存的修改。');
  expect((await detail()).content).toContain('其他页面的新内容。');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('dialog', { name: '还有未保存的章节修改' }).getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(page.locator('.read-content')).toContainText('其他页面的新内容。');
  // Section drafts survive reload and reopen in the full editor for recovery.
  await page.getByRole('button', { name: '管理章节 第二节', exact: true }).click();
  await page.getByRole('button', { name: '编辑本节', exact: true }).click();
  await field.fill('## 第二节\n\n重新打开后恢复的章节修改。');
  const draftKey = `note-draft:section:${node.id}`;
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), draftKey)).toContain('重新打开后恢复');
  page.once('dialog', (dialog) => dialog.accept());
  await page.reload();
  await page.getByRole('dialog', { name: '恢复未保存的草稿？' }).getByRole('button', { name: '恢复草稿', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown 源码' });
  await expect(source).toContainText('重新打开后恢复的章节修改。');
  expect(await page.evaluate((key) => localStorage.getItem(key), draftKey)).toBeNull();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(source).toHaveCount(0);
  await expect.poll(async () => (await detail()).content).toContain('重新打开后恢复的章节修改。');
  await noteAction(page, '关闭快捷编辑');
  await expect(page.locator('.section-trigger, .quick-append')).toHaveCount(0);
  expect(errors).toEqual([]);
});
