import { expect, test } from './fixtures';
import { createNote, edit, login, selectTheme, writeSource } from './notebook-helpers';

test('renders Gantt and flowcharts across themes without widening the page and keeps invalid source', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  await createNote(page, '图表笔记');
  await edit(page);
  await writeSource(page, '# 迭代计划\n\n```mermaid\ngantt\n  title 项目计划\n  dateFormat YYYY-MM-DD\n  axisFormat %m-%d\n  todayMarker off\n  section 开发\n  需求梳理 :done, a, 2026-10-27, 3d\n  功能开发 :active, b, after a, 5d\n  测试验收 :c, after b, 2d\n```\n\n```mermaid\nflowchart LR\n  A[开始] --> B[完成]\n```\n\n```mermaid\nnot a valid diagram\n```\n\n```js\nconst gantt = true;\n```');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const images = page.locator('.mermaid-diagram img');
  for (const theme of ['light', 'dark', 'starry']) {
    await selectTheme(page, theme);
    await expect(images).toHaveCount(2);
    await expect.poll(() => images.evaluateAll((items) => items.every((item) => (item as HTMLImageElement).complete && (item as HTMLImageElement).naturalWidth > 0))).toBe(true);
    const first = images.first();
    const svg = decodeURIComponent((await first.getAttribute('src'))!.split(',').slice(1).join(','));
    expect(svg).toContain('项目计划');
    expect(svg).toContain('需求梳理');
    expect(svg).toContain('功能开发');
    expect(svg).toContain('测试验收');
    expect(svg).not.toContain('foreignObject');
    const flowchart = decodeURIComponent((await images.nth(1).getAttribute('src'))!.split(',').slice(1).join(','));
    expect(flowchart).toContain('marker-end="url(#');
    await expect(page.locator('.mermaid-status')).toContainText('请检查 Mermaid 语法');
    await expect(page.locator('pre code.language-mermaid')).toHaveText('not a valid diagram\n');
    await expect(page.locator('pre code.language-js')).toHaveText('const gantt = true;\n');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/mermaid-${theme}-${info.project.name}.png`, fullPage: true });
  }
  await images.first().click();
  const viewer = page.getByRole('dialog', { name: 'Mermaid 图表' });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole('link', { name: '下载图片' })).toHaveAttribute('download', 'diagram.svg');
  await viewer.getByRole('button', { name: '放大图片' }).click();
  await expect(viewer.locator('.image-toolbar')).toContainText('125%');
  await viewer.getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload();
  await expect(images).toHaveCount(2);
  expect(errors).toEqual([]);
});
