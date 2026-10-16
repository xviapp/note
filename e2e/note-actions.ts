import type { Page, Locator } from '@playwright/test';

// Secondary note actions sit in the toolbar on wide screens and move into the
// ⋯ menu on phones; both use the same accessible name.
export async function noteAction(page: Page, name: string | RegExp) {
  const actions = page.locator('.note-actions');
  const target = page.locator('.note-toolbar').getByRole('button', { name, exact: typeof name === 'string' });
  if (!(await target.first().isVisible())) await actions.locator('.node-menu > summary').click();
  await target.first().click();
}

export async function editorAction(page: Page, name: string) {
  const target = page.getByRole('button', { name, exact: true });
  if (!(await target.isVisible())) await page.getByRole('button', { name: '更多编辑操作' }).click();
  await target.click();
}

export async function chooseNodeType(form: Locator, name: string) {
  const target = form.getByRole('radio', { name, exact: true });
  if (!(await target.isVisible())) await form.getByRole('button', { name: '更多类型' }).click();
  await target.check();
}
