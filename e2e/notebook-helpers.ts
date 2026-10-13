import { expect, type Page } from './fixtures';

export const password = 'Note2026';
const token = 'e2e-test-only-setup-token-never-deploy-0001';
export async function expectPreview(page: Page) {
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.locator('.cm-editor, .edit-toolbar')).toHaveCount(0);
}
export async function login(page: Page) {
  const status = await (await page.request.get('/api/auth/status')).json();
  await page.goto(status.initialized ? '/' : `/#setup=${token}`);
  if (!status.initialized) {
    await expect(page.getByLabel('设置密码', { exact: true })).toHaveAttribute('minlength', '8');
    await page.getByLabel('设置密码', { exact: true }).fill(password);
    await page.getByLabel('确认密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '创建笔记库' }).click();
  } else {
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '打开笔记库' }).click();
  }
  await expectPreview(page);
}
export async function createNote(page: Page, title: string) {
  await page.getByRole('button', { name: '新建', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新建笔记' });
  await form.getByLabel('标题', { exact: true }).fill(title);
  await form.getByRole('button', { name: '创建', exact: true }).click();
  // A new, empty note opens for writing (phones then show only the source);
  // these tests start from the preview.
  await expect(page.getByRole('textbox', { name: 'Markdown 源码' })).toBeFocused();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
}
export async function edit(page: Page) {
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown 源码' })).toBeVisible();
}
export async function selectTheme(page: Page, value: string) {
  const theme = page.getByRole('combobox', { name: '主题', exact: true });
  const openDrawer = !(await theme.isVisible());
  const reopenAssistant =
    openDrawer && (await page.locator('.assistant-panel[aria-label="青藜"]').isVisible());
  if (reopenAssistant) await page.getByRole('button', { name: '关闭青藜', exact: true }).click();
  if (openDrawer) await page.getByRole('button', { name: '打开笔记目录', exact: true }).click();
  await theme.selectOption(value);
  if (openDrawer) await page.getByRole('button', { name: '关闭侧栏', exact: true }).click();
  if (reopenAssistant) await page.getByRole('button', { name: '打开青藜', exact: true }).click();
}
export async function nav(page: Page, name: string, section = '青藜') {
  const drawer = page.getByRole('button', { name: '打开笔记目录' });
  if (await drawer.isVisible()) await drawer.click();
  await page.locator('.main-nav').getByRole('button', { name, exact: true }).click();
  if (name === '设置')
    await page.locator('.settings-entry').getByText(section, { exact: true }).click();
}

export async function assistantSeed(page: Page, data: Record<string, unknown>) {
  const headers = { origin: 'http://127.0.0.1:8799' };
  const node = await (
    await page.request.post('/api/nodes', {
      headers,
      data,
    })
  ).json();
  return { node };
}
