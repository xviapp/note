import { test, expect } from './fixtures';
import { login } from './notebook-helpers';

const headers = { origin: 'http://127.0.0.1:8799' };

// The home page leads back to what was read last, with where reading stopped.
test('继续阅读 opens the last note read at its progress', async ({ page }, info) => {
  await login(page);
  const card = page.locator('.continue-reading');
  await expect(card).toHaveCount(0);
  const post = async (data: object) => (await page.request.post('/api/nodes', { headers, data })).json();
  const folder = await post({ kind: 'folder', title: '书架' });
  const note = await post({ kind: 'markdown', title: '读到一半的笔记', content: '# 正文' });
  await page.request.post(`/api/nodes/${note.id}/open`, { headers, data: {} });
  await page.request.put(`/api/nodes/${note.id}/reading`, {
    headers,
    data: { version: 0, position: { ratio: 0.42 } },
  });
  // A folder opened later is not something to continue reading.
  await page.request.post(`/api/nodes/${folder.id}/open`, { headers, data: {} });
  await page.goto('/');
  await expect(card).toContainText('继续阅读 · 读到 42%');
  await expect(card).toContainText('读到一半的笔记');
  for (const theme of ['light', 'dark', 'starry']) {
    await page.evaluate((value) => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'note:theme', newValue: value }));
    }, theme);
    await page.screenshot({ path: info.outputPath(`home-${theme}.png`) });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  await card.click();
  await expect(page).toHaveURL(new RegExp(`/n/${note.id}$`));
});
