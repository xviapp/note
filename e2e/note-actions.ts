import type { Page } from '@playwright/test';

// Secondary note actions sit in the toolbar on wide screens and move into the
// ⋯ menu on phones; both use the same accessible name.
export async function noteAction(page: Page, name: string | RegExp) {
  const actions = page.locator('.note-actions');
  const target = actions.getByRole('button', { name, exact: typeof name === 'string' });
  if (!(await target.first().isVisible())) await actions.locator('.node-menu > summary').click();
  await target.first().click();
}
export const openAttachments = (page: Page) => noteAction(page, /^附件/);
