import { expect, test } from './fixtures';
import { edit, login, selectTheme, writeSource } from './notebook-helpers';

const headers = { origin: 'http://127.0.0.1:8799' };

test('the phone format bar formats Markdown above the keyboard and keeps the editor focused', async ({
  page,
}, info) => {
  await login(page);
  const node = await (
    await page.request.post('/api/nodes', {
      headers,
      data: { kind: 'markdown', title: '格式.md', content: '' },
    })
  ).json();
  await page.goto(`/n/${node.id}`);
  await edit(page);
  const source = page.getByRole('textbox', { name: 'Markdown 源码' });
  const bar = page.getByRole('toolbar', { name: '格式' });
  if (info.project.name !== 'mobile') {
    // Pointers with a keyboard keep the shortcuts and never see the bar.
    await source.click();
    await expect(bar).toHaveCount(0);
    return;
  }

  await writeSource(page, '标题');
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: '标题' }).tap();
  await bar.getByRole('button', { name: '标题' }).tap();
  await expect(source).toHaveText('## 标题', { useInnerText: true });
  await expect(source).toBeFocused();

  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await bar.getByRole('button', { name: '待办' }).tap();
  await page.keyboard.insertText('买书');
  // Enter continues the list; tapping 待办 again ends it.
  await page.keyboard.press('Enter');
  await bar.getByRole('button', { name: '待办' }).tap();
  await bar.getByRole('button', { name: '加粗' }).tap();
  await page.keyboard.insertText('重点');
  await expect(source).toHaveText('## 标题\n- [ ] 买书\n**重点**', { useInnerText: true });

  await bar.getByRole('button', { name: '撤销' }).tap();
  await expect(source).not.toContainText('重点');
  await bar.getByRole('button', { name: '重做' }).tap();
  await expect(source).toHaveText('## 标题\n- [ ] 买书\n**重点**', { useInnerText: true });

  // It sits at the bottom of the visual viewport, so the keyboard pushes it up.
  const viewport = page.viewportSize()!;
  const box = (await bar.boundingBox())!;
  expect(Math.round(box.y + box.height)).toBe(viewport.height);
  for (const theme of ['light', 'dark', 'starry']) {
    await selectTheme(page, theme);
    await source.click();
    await expect(bar).toBeVisible();
    await page.screenshot({ path: info.outputPath(`format-bar-${theme}.png`) });
  }

  // Leaving the editor hides it.
  await page.getByRole('button', { name: '取消', exact: true }).tap();
  await expect(bar).toHaveCount(0);
});
