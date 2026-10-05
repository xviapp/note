import { expect, test, type Locator, type Page } from './fixtures';
import { noteAction } from './note-actions';
import { preparePassword } from '../shared/password';

const headers = { origin: 'http://127.0.0.1:8799' };
const toolbar = (page: Page) => page.getByRole('toolbar', { name: '选中文字操作' });
async function login(page: Page) {
  const status = await (await page.request.get('/api/auth/status')).json();
  const response = await page.request.post(`/api/auth/${status.initialized ? 'login' : 'setup'}`, {
    headers,
    data: {
      password: await preparePassword('Note2026', status.initialized ? status.password : undefined),
      ...(!status.initialized ? { token: 'e2e-test-only-setup-token-never-deploy-0001' } : {}),
    },
  });
  expect(response.ok()).toBeTruthy();
}
// Selects a paragraph and waits for the toolbar, as in selection-toolbar.spec.ts.
async function selectText(page: Page, locator: Locator) {
  await expect(async () => {
    await locator.evaluate(async (element) => {
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.addRange(range);
    });
    await expect(toolbar(page)).toBeVisible({ timeout: 1000 });
  }).toPass();
}

test('highlights and notes are saved, reopened, listed in order and exported', async ({
  page,
}, info) => {
  await login(page);
  const note = await (
    await page.request.post('/api/nodes', {
      headers,
      data: {
        kind: 'markdown',
        title: `带批注 · ${info.project.name}`,
        content: '第一段需要记住。\n\n第二段值得批注。\n\n第三段普通文字。',
      },
    })
  ).json();
  await page.goto(`/n/${note.id}`);
  const paragraphs = page.locator('.read-content p');
  await expect(paragraphs.nth(2)).toHaveText('第三段普通文字。');

  // A note on the second paragraph first, then a plain highlight on the first.
  await selectText(page, paragraphs.nth(1));
  await toolbar(page).getByRole('button', { name: '批注' }).click();
  const editor = page.getByRole('dialog', { name: '添加批注' });
  await expect(editor.locator('blockquote')).toHaveText('第二段值得批注。');
  await editor.getByLabel('批注内容').fill('这是我的想法');
  await editor.getByRole('button', { name: '保存' }).click();
  await expect(editor).toBeHidden();
  await selectText(page, paragraphs.nth(0));
  await toolbar(page).getByRole('button', { name: '高亮' }).click();
  await expect(toolbar(page)).toBeHidden();

  // Both stay after a reload, and a click on the text opens its note.
  await page.reload();
  await expect(paragraphs.nth(1)).toHaveText('第二段值得批注。');
  await expect
    .poll(() => page.evaluate(() => CSS.highlights.get('annotation-note')?.size ?? 0))
    .toBe(1);
  expect(await page.evaluate(() => CSS.highlights.get('annotation')?.size ?? 0)).toBe(1);
  await paragraphs.nth(1).click({ position: { x: 24, y: 8 } });
  const saved = page.getByRole('dialog', { name: '批注', exact: true });
  await expect(saved.getByLabel('批注内容')).toHaveValue('这是我的想法');
  await saved.getByRole('button', { name: '关闭' }).click();
  await expect(saved).toBeHidden();

  // The list follows the text, and exports as a child note.
  await noteAction(page, '批注（2）');
  const list = page.getByRole('dialog', { name: '批注（2）' });
  await expect(list.locator('.annotation-item-quote')).toHaveText([
    '第一段需要记住。',
    '第二段值得批注。',
  ]);
  await list.getByRole('button', { name: '导出为子笔记' }).click();
  await expect(list.getByText(/已保存为子笔记「.*（批注）」（2 条）/)).toBeVisible();
  const children = (await (await page.request.get(`/api/nodes?parent=${note.id}`)).json()).nodes;
  const child = await (await page.request.get(`/api/nodes/${children[0].id}`)).json();
  expect(child.title).toBe(`${note.title}（批注）`);
  expect(child.content.indexOf('> 第一段需要记住。')).toBeLessThan(
    child.content.indexOf('> 第二段值得批注。\n\n这是我的想法'),
  );

  // Deleting from the editor removes the highlight.
  await list.getByRole('button', { name: '编辑批注' }).first().click();
  await page
    .getByRole('dialog', { name: '批注', exact: true })
    .getByRole('button', { name: '删除' })
    .click();
  await expect.poll(() => page.evaluate(() => CSS.highlights.get('annotation')?.size ?? 0)).toBe(0);
  const remaining = (await (await page.request.get(`/api/nodes/${note.id}/annotations`)).json())
    .annotations;
  expect(remaining.map((item: { note: string }) => item.note)).toEqual(['这是我的想法']);
});
