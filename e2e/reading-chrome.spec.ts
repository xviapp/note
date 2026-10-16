import { test, expect } from './fixtures';
import { login } from './notebook-helpers';
import { noteAction } from './note-actions';

const headers = { origin: 'http://127.0.0.1:8799' };

test('reading keeps a compact toolbar and its secondary actions remain usable', async ({ page }, info) => {
  await login(page);
  const response = await page.request.post('/api/nodes', {
    headers,
    data: {
      kind: 'markdown',
      title: '阅读笔记：把知识变成自己的理解',
      content: '# 从记录到理解\n\n阅读时，把新的观点与已有的经验联系起来。\n\n## 留下问题\n\n记录下一次阅读想要验证的想法。',
    },
  });
  expect(response.ok()).toBeTruthy();
  const note = await response.json();
  for (const width of info.project.name === 'mobile' ? [390, 320] : [1440]) {
    await page.setViewportSize({ width, height: width > 760 ? 960 : 844 });
    await page.goto(`/n/${note.id}`);
    await expect(page.locator('.read-content')).toContainText('从记录到理解');
    if (width < 760) {
      await expect(page.locator('.edit-label-short')).toBeVisible();
      await expect(page.locator('.new-child')).toBeHidden();
      expect((await page.locator('.note-toolbar').boundingBox())!.height).toBeLessThanOrEqual(65);
    }
    for (const theme of ['light', 'dark', 'starry']) {
      await page.evaluate((value) => {
        window.dispatchEvent(new StorageEvent('storage', { key: 'note:theme', newValue: value }));
      }, theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      await page.screenshot({ path: info.outputPath(`reading-${width}-${theme}.png`) });
    }
    await noteAction(page, '阅读设置');
    const settings = page.getByRole('dialog', { name: '阅读设置', exact: true });
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: '紧凑', exact: true }).click();
    await settings.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(settings).toHaveCount(0);
    if (width < 760) await expect(page.locator('.note-actions .node-menu > summary')).toBeFocused();
    await noteAction(page, '收藏笔记');
    await expect(page.locator('.note-actions .is-favorite')).toHaveCount(1);
    await noteAction(page, '取消收藏');
    await expect(page.locator('.note-actions .is-favorite')).toHaveCount(0);
    if (width < 760) await page.setViewportSize({ width, height: 480 });
    await page.locator('.note-actions .node-menu > summary').click();
    if (width < 760) {
      const last = page.locator('.note-actions').getByRole('button', { name: '移到回收站', exact: true });
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeInViewport();
      const popup = (await page.locator('.note-actions .menu-popup').boundingBox())!;
      expect(popup.y + popup.height).toBeLessThanOrEqual(480);
    }
    await page.locator('.note-actions').getByRole('button', { name: '新建笔记', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '新建笔记', exact: true })).toBeVisible();
    await page.getByRole('dialog', { name: '新建笔记', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
  }
});
