import { expect, test, type Page } from './fixtures';
import { preparePassword } from '../shared/password';

const headers = { origin: 'http://127.0.0.1:8799' };
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
async function create(page: Page, data: object) {
  const response = await page.request.post('/api/nodes', { headers, data });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
const source = (page: Page) => page.getByRole('textbox', { name: 'Markdown 源码' });
async function startEditing(page: Page) {
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await page.getByRole('button', { name: '开始编辑', exact: true }).click();
  await expect(source(page)).toBeVisible();
}
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

test('Ctrl+S keeps editing, images and links go to the cursor, and pasted images upload', async ({
  page,
}, info) => {
  await login(page);
  const note = await create(page, {
    kind: 'markdown',
    title: `写作 ${info.project.name}`,
    content: '第一段\n\n第二段',
  });
  await page.goto(`/n/${note.id}`);
  await startEditing(page);
  // Put the cursor at the end of the first paragraph.
  await source(page).click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('End');
  await page
    .getByLabel('上传附件', { exact: true })
    .setInputFiles({ name: 'cursor.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByText('上传中…')).toHaveCount(0);
  await expect(source(page)).toContainText('第一段![cursor.png]');
  const text = await source(page).innerText();
  expect(text.indexOf('![cursor.png]')).toBeLessThan(text.indexOf('第二段'));

  // A pasted image is uploaded and inserted at the cursor too.
  await page.keyboard.press('Control+End');
  await source(page).evaluate((element, bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], 'pasted.png', { type: 'image/png' }));
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, Array.from(png));
  await expect(source(page)).toContainText('![pasted.png]');
  await expect(page.getByText('上传中…')).toHaveCount(0);

  // Ctrl+S saves and stays in the editor; 保存 saves and returns to reading.
  await page.keyboard.press('Control+s');
  await expect(page.locator('.edit-toolbar')).toBeVisible();
  await expect(source(page)).toBeVisible();
  // Typing on right away must survive the save finishing in the background.
  await page.keyboard.type('\n继续写');
  await expect
    .poll(async () => (await (await page.request.get(`/api/nodes/${note.id}`)).json()).attachments)
    .toHaveLength(2);
  await page.waitForTimeout(900);
  await expect(source(page)).toContainText('继续写');
  await expect(page.locator('.editing-label')).toContainText('未保存');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await expect(page.locator('.read-content')).toContainText('继续写');
});

test('unsaved edits survive a reload and can be restored or discarded', async ({ page }, info) => {
  await login(page);
  const note = await create(page, {
    kind: 'markdown',
    title: `草稿 ${info.project.name}`,
    content: '原文',
  });
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto(`/n/${note.id}`);
  await startEditing(page);
  await source(page).fill('还没保存的草稿');
  // The draft is written shortly after typing stops.
  await page.waitForTimeout(900);
  await page.reload();
  const offer = page.getByRole('dialog', { name: '恢复未保存的草稿？' });
  await expect(offer).toBeVisible();
  await offer.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await expect(source(page)).toContainText('还没保存的草稿');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.read-content')).toContainText('还没保存的草稿');
  await page.reload();
  await expect(page.locator('.read-content')).toContainText('还没保存的草稿');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await startEditing(page);
  await source(page).fill('要丢掉的草稿');
  await page.waitForTimeout(900);
  await page.reload();
  await page
    .getByRole('dialog', { name: '恢复未保存的草稿？' })
    .getByRole('button', { name: '丢弃草稿', exact: true })
    .click();
  await expect(page.locator('.read-content')).toContainText('还没保存的草稿');
  await page.reload();
  await expect(page.locator('.read-content')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('search jumps to a note by title words and shows where it lives', async ({ page }, info) => {
  await login(page);
  const folder = await create(page, { kind: 'folder', title: `资料 ${info.project.name}` });
  const target = await create(page, {
    kind: 'markdown',
    title: `Transformer 读书笔记 ${info.project.name}`,
    parentId: folder.id,
    content: '正文',
  });
  await create(page, { kind: 'markdown', title: `另一篇 ${info.project.name}`, content: '正文' });
  await page.goto('/');
  await expect(page.locator('.app-shell')).toBeVisible();
  if (info.project.name === 'desktop') await page.keyboard.press('Control+k');
  else await page.locator('.app-header').getByRole('button', { name: '搜索笔记' }).click();
  const dialog = page.getByRole('dialog', { name: '搜索笔记', exact: true });
  const field = dialog.getByRole('combobox', { name: '搜索笔记标题' });
  await expect(field).toBeFocused();
  await field.fill(`transformer ${info.project.name}`);
  const option = dialog.getByRole('option').filter({ hasText: target.title });
  await expect(option).toBeVisible();
  await expect(option).toContainText(folder.title);
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await field.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/n/${target.id}$`));
  if (info.project.name === 'desktop') {
    // E edits the open note; / opens search when no field has focus.
    await page.locator('.read-content').click();
    await page.keyboard.press('e');
    await expect(page.getByRole('dialog', { name: '编辑这篇笔记？' })).toBeVisible();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.keyboard.press('/');
    await expect(dialog).toBeVisible();
    await field.fill('没有这样的标题');
    await expect(dialog.getByText('没有标题匹配的笔记')).toBeVisible();
  }
});

test('a single note is deleted with undo, while a note with children asks first', async ({
  page,
}, info) => {
  await login(page);
  const single = await create(page, { kind: 'markdown', title: `单篇 ${info.project.name}` });
  const branch = await create(page, { kind: 'markdown', title: `有下级 ${info.project.name}` });
  await create(page, { kind: 'markdown', title: `下级 ${info.project.name}`, parentId: branch.id });
  const menu = page.locator('.note-actions .node-menu');
  await page.goto(`/n/${single.id}`);
  await menu.getByRole('button', { name: `管理 ${single.title}`, exact: true }).click();
  await menu.getByRole('button', { name: '移到回收站', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const toast = page.getByRole('status').filter({ hasText: '已移到回收站' });
  await expect(toast).toBeVisible();
  await expect(page).not.toHaveURL(new RegExp(`/n/${single.id}$`));
  await toast.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已恢复' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/n/${single.id}$`));
  expect((await (await page.request.get(`/api/nodes/${single.id}`)).json()).trash_id).toBeNull();

  await page.goto(`/n/${branch.id}`);
  await menu.getByRole('button', { name: `管理 ${branch.title}`, exact: true }).click();
  await menu.getByRole('button', { name: '移到回收站', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '移到回收站？' });
  await expect(confirm).toContainText('共 2 项内容');
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/n/${branch.id}$`));
});
