import { expect, test } from './fixtures';
import { expectPreview, login, createNote, edit, selectTheme, nav } from './notebook-helpers';

test('themes persist, follow the system and preserve the current note and unsaved editor', async ({
  page,
  context,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: 'dark' });
  await login(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await createNote(page, `项目笔记 · ${info.project.name}`);
  await edit(page);
  const content =
    '# 阅读器更新\n\n## 本周任务\n\n- [x] 连续阅读 PDF\n- [x] 主题切换\n- [ ] 整理项目资料\n\n## 实施记录\n\n> 主题选择保存在当前设备，刷新后继续使用。\n\n| 项目 | 状态 |\n| --- | --- |\n| 手机布局 | 已完成 |\n| 阅读位置 | 已完成 |\n\n```js\nconst mode = "dark";\n```\n\n[项目文档](https://example.com)';
  await page.getByRole('textbox', { name: 'Markdown 源码' }).fill(content);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const url = page.url();
  const theme = page.getByRole('combobox', { name: '主题', exact: true, includeHidden: true });
  for (const palette of ['light', 'dark', 'starry']) {
    await selectTheme(page, palette);
    await expect(page.locator('html')).toHaveAttribute('data-theme', palette);
    await expect(page.locator('.markdown-body')).toContainText('阅读器更新');
    await expect(page.locator('.cm-editor')).toHaveCount(0);
    expect(page.url()).toBe(url);
    // Check actual rendered text against the reading surface, including small metadata.
    const contrast = await page.locator('.document-meta').evaluate((element) => {
      const luminance = (color: string) => {
        const channels = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((value) => {
            const c = value / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      const foreground = luminance(getComputedStyle(element).color);
      const background = luminance(getComputedStyle(document.documentElement).backgroundColor);
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: `test-results/theme-${palette}-${info.project.name}.png` });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await page.reload();
  await expect(theme).toHaveValue('starry');
  await expectPreview(page);
  await edit(page);
  const source = page.getByRole('textbox', { name: 'Markdown 源码' });
  await source.fill(`${content}\n\n未保存的主题测试草稿`);
  // The editor takes the app's own surface and ink in every palette.
  const editorMatches = () =>
    page.evaluate(() => {
      const editor = getComputedStyle(document.querySelector('.cm-editor')!);
      const pane = getComputedStyle(document.querySelector('.source-pane')!);
      const body = getComputedStyle(document.body);
      return editor.backgroundColor === pane.backgroundColor && editor.color === body.color;
    });
  await selectTheme(page, 'dark');
  await expect.poll(editorMatches).toBe(true);
  await selectTheme(page, 'light');
  await expect.poll(editorMatches).toBe(true);
  await expect(source).toContainText('未保存的主题测试草稿');
  await selectTheme(page, 'starry');
  await expect(source).toContainText('未保存的主题测试草稿');
  await page.screenshot({ path: `test-results/theme-editor-${info.project.name}.png` });
  await page.getByRole('button', { name: '保存', exact: true }).click();

  const other = await context.newPage();
  // The small bootstrap must apply the saved palette even before React is available.
  await other.route('**/assets/index-*.js', (route) => route.abort());
  await other.goto('/');
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'starry');
  await other.unroute('**/assets/index-*.js');
  await other.emulateMedia({ colorScheme: 'light' });
  await other.goto(url);
  await expect(
    other.getByRole('combobox', { name: '主题', exact: true, includeHidden: true }),
  ).toHaveValue('starry');
  await selectTheme(page, 'system');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await selectTheme(page, 'dark');
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark');
  await other.close();

  await nav(page, '设置', '外观');
  await page.getByRole('radio', { name: '星空', exact: true }).check();
  await expect(theme).toHaveValue('starry');
  await page.screenshot({ path: `test-results/theme-settings-${info.project.name}.png` });
  await nav(page, '设置', '密码与设备');
  await page.getByRole('button', { name: '退出当前设备', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开笔记库', exact: true })).toBeVisible();
  await expect(theme).toHaveValue('starry');
  await page.getByRole('button', { name: '忘记密码？', exact: true }).click();
  await expect(page.locator('.auth-form')).toContainText('在部署端重置密码');
  await page.screenshot({ path: `test-results/theme-login-${info.project.name}.png` });
  expect(errors).toEqual([]);
});
