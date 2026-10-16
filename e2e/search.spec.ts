import { test, expect } from './fixtures';
import { login } from './notebook-helpers';

const headers = { origin: 'http://127.0.0.1:8799' };

// A word in the body finds the note, shows the words around it, and opening
// the result scrolls to it.
test('body search shows context and goes to the word', async ({ page }, info) => {
  await login(page);
  const filler = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 段：铺垫的文字。`).join('\n\n');
  const response = await page.request.post('/api/nodes', {
    headers,
    data: { kind: 'markdown', title: '长篇读书笔记', content: `# 读书\n\n${filler}\n\n最后写下**关键的结论**在这里。` },
  });
  const note = await response.json();
  await page.goto('/');
  await page.keyboard.press('ControlOrMeta+k');
  const dialog = page.getByRole('dialog', { name: '搜索笔记', exact: true });
  if (!(await dialog.isVisible())) await page.locator('.app-header').getByRole('button', { name: '搜索笔记' }).click();
  await dialog.getByRole('combobox', { name: '搜索笔记标题、正文或批注' }).fill('关键的结论');
  const option = dialog.getByRole('listbox', { name: '搜索结果' }).getByRole('option').filter({ hasText: '长篇读书笔记' });
  await expect(option.locator('.search-excerpt')).toContainText('最后写下关键的结论在这里。');
  await expect(option.locator('.search-excerpt mark')).toHaveText('关键的结论');
  await page.screenshot({ path: info.outputPath('search-excerpt.png') });
  await option.click();
  await expect(page).toHaveURL(new RegExp(`/n/${note.id}$`));
  // The word is scrolled into view.
  const target = page.locator('.read-content p').filter({ hasText: '关键的结论' });
  await expect(target).toBeInViewport();
  await expect(page.locator('.read-content p').filter({ hasText: '第 1 段' })).not.toBeInViewport();
});
