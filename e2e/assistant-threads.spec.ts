import { expect, test, type Page } from './fixtures';
import { login } from './notebook-helpers';
import type { NoteNode } from '../shared/types';

const headers = { origin: 'http://127.0.0.1:8799' };
const post = async <T = NoteNode>(page: Page, path: string, data: unknown): Promise<T> => {
  const response = await page.request.post(path, { headers, data });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as T;
};
// A real conversation: the e2e server answers through its DeepSeek stand-in.
const ask = async (page: Page, id: string, content: string) => {
  const response = await page.request.post(`/api/nodes/${id}/assistant`, { headers, data: { content } });
  expect(response.ok(), await response.text()).toBe(true);
  await response.body();
};

test('青藜对话 lists every conversation and opens a note or a book discussion with 青藜 shown', async ({
  page,
}, info) => {
  await login(page);
  await page.request.put('/api/ai/settings', { headers, data: { apiKey: 'sk-e2e-placeholder-key' } });
  const folder = await post(page, '/api/nodes', { kind: 'folder', title: '读书' });
  const chapter = await post(page, '/api/nodes', { kind: 'markdown', title: '第一章', parentId: folder.id, content: '# 第一章' });
  await post(page, '/api/nodes', { kind: 'markdown', title: '没聊过', content: '正文' });
  const book = await post(page, '/api/nodes', { kind: 'folder', title: '人类简史', book: { author: '作者', pageCount: 20 } });
  const bookPage = await post(page, `/api/nodes/${book.id}/pages`, { page: 3, content: '## 农业革命\n\n原文。' });
  const discussion = await post(page, `/api/nodes/${bookPage.id}/discussions`, { title: '小麦驯化了人类？' });
  await ask(page, chapter.id, '第一章讲了什么');
  await ask(page, chapter.id, '再解释一下');
  await ask(page, discussion.id, '小麦驯化了人类？');
  await page.goto(`/n/${folder.id}`);

  // Notes with a conversation are marked in lists.
  const rows = page.locator('.node-list-main');
  await expect(rows.filter({ hasText: '第一章' }).getByRole('img', { name: '有青藜对话' })).toBeVisible();

  const drawer = page.getByRole('button', { name: '打开笔记目录' });
  if (await drawer.isVisible()) await drawer.click();
  await page.locator('.main-nav').getByRole('button', { name: '青藜对话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '青藜对话' });
  const options = dialog.getByRole('option');
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText('小麦驯化了人类？');
  await expect(options.nth(0)).toContainText('人类简史 / 第 3 页');
  await expect(options.nth(1)).toContainText('2 次提问');
  await expect(options.nth(1)).toContainText('读书');
  for (const theme of ['light', 'dark', 'starry']) {
    await page.evaluate((value) => window.dispatchEvent(new StorageEvent('storage', { key: 'note:theme', newValue: value })), theme);
    await page.screenshot({ path: info.outputPath(`assistant-threads-${theme}.png`) });
  }

  // Filtering by title, then opening a note shows its conversation.
  await dialog.getByRole('combobox', { name: '按笔记标题或位置筛选' }).fill('第一章');
  await expect(options).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/n/${chapter.id}$`));
  const panel = page.getByRole('complementary', { name: '青藜', exact: true });
  await expect(panel.getByText('再解释一下', { exact: true })).toBeVisible();

  // From 青藜's own header: a discussion opens on its page.
  await panel.getByRole('button', { name: '全部青藜对话', exact: true }).click();
  await dialog.getByRole('option').filter({ hasText: '小麦驯化了人类？' }).click();
  await expect(page).toHaveURL(new RegExp(`/n/${bookPage.id}$`));
  await expect(panel.getByText('小麦驯化了人类？', { exact: true }).first()).toBeVisible();
  await expect(panel.getByText('先回答：作者是说个体的生活变差了。')).toBeVisible();

  // A cleared conversation leaves the list and its mark goes.
  await page.goto(`/n/${chapter.id}`);
  await page.getByRole('button', { name: '打开青藜', exact: true }).click();
  await panel.getByRole('button', { name: '清空会话', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '清空会话', exact: true }).click();
  await expect(panel.getByText('再解释一下', { exact: true })).toHaveCount(0);
  await page.goto(`/n/${folder.id}`);
  await expect(rows.filter({ hasText: '第一章' })).toBeVisible();
  await expect(rows.filter({ hasText: '第一章' }).getByRole('img', { name: '有青藜对话' })).toHaveCount(0);
});
