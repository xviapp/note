import { expect, test, type Page } from './fixtures';
import { login } from './notebook-helpers';

const headers = { origin: 'http://127.0.0.1:8799' };
async function create(page: Page, data: object) {
  const response = await page.request.post('/api/nodes', { headers, data });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<{ id: string; title: string }>;
}
const parentOf = async (page: Page, id: string) =>
  (await (await page.request.get(`/api/nodes/${id}`)).json()).parent_id;
const row = (id: string) => `[data-tree-node="${id}"]`;

test('selects several notes with Ctrl and Shift, then moves and deletes them together', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'Selecting several notes is a desktop feature.');
  await login(page);
  const target = await create(page, { kind: 'folder', title: '归档' });
  const notes = [];
  for (const title of ['甲', '乙', '丙', '丁']) notes.push(await create(page, { kind: 'markdown', title, content: title }));
  await page.goto('/');
  const tree = page.locator('.sidebar-tree');
  const label = (title: string) => tree.getByRole('button', { name: title, exact: true });
  await expect(label('丁')).toBeVisible();

  // Click opens 甲; Ctrl + click adds 丙 to it without opening.
  await label('甲').click();
  await expect(page).toHaveURL(new RegExp(`/n/${notes[0].id}$`));
  await label('丙').click({ modifiers: ['ControlOrMeta'] });
  await expect(page).toHaveURL(new RegExp(`/n/${notes[0].id}$`));
  const bar = page.getByRole('toolbar', { name: '已选条目' });
  await expect(bar).toContainText('已选 2 项');
  await expect(bar).toBeInViewport();
  // Shift selects from the last clicked row (丙) to 丁; with Ctrl it keeps 甲 too.
  await label('丁').click({ modifiers: ['Shift'] });
  await expect(bar).toContainText('已选 2 项');
  await expect(tree.locator(row(notes[0].id))).not.toHaveClass(/is-multi-selected/);
  await label('甲').click({ modifiers: ['ControlOrMeta'] });
  await label('丁').click({ modifiers: ['ControlOrMeta', 'Shift'] });
  await expect(bar).toContainText('已选 4 项');
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);

  // Moving: the selection goes into a folder chosen in the dialog, undone at once.
  await label('乙').click({ modifiers: ['ControlOrMeta'] });
  await label('丙').click({ modifiers: ['ControlOrMeta'] });
  await expect(bar).toContainText('已选 2 项');
  await bar.getByRole('button', { name: '移动到…' }).click();
  const dialog = page.getByRole('dialog', { name: '移动 2 项' });
  await dialog.getByRole('button', { name: '归档', exact: true }).click();
  await dialog.getByRole('button', { name: '确认移动' }).click();
  await expect(page.locator('.move-toast')).toContainText('已将 2 项移到「归档」');
  await expect.poll(() => parentOf(page, notes[1].id)).toBe(target.id);
  await expect.poll(() => parentOf(page, notes[2].id)).toBe(target.id);
  await expect(bar).toHaveCount(0);
  await page.locator('.move-toast').getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(() => parentOf(page, notes[1].id)).toBeNull();
  await expect.poll(() => parentOf(page, notes[2].id)).toBeNull();

  // Dragging one selected row carries the others.
  await label('乙').click({ modifiers: ['ControlOrMeta'] });
  await label('丁').click({ modifiers: ['ControlOrMeta'] });
  const from = (await tree.locator(row(notes[1].id)).boundingBox())!;
  const onto = (await tree.locator(row(target.id)).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2 + 4, { steps: 4 });
  await expect(page.locator('.tree-drag-ghost')).toContainText('乙等 2 项');
  await page.mouse.move(onto.x + onto.width / 2, onto.y + onto.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => parentOf(page, notes[3].id)).toBe(target.id);
  expect(await parentOf(page, notes[1].id)).toBe(target.id);
  expect(await parentOf(page, notes[0].id)).toBeNull();

  // Deleting from the folder's list: one question, one 撤销 for all.
  await page.goto(`/n/${target.id}`);
  const list = page.locator('.main-content .node-list');
  const item = (title: string) => list.locator('.node-list-main', { hasText: title });
  await item('乙').click({ modifiers: ['ControlOrMeta'] });
  await item('丁').click({ modifiers: ['Shift'] });
  await expect(bar).toContainText('已选 2 项');
  await bar.getByRole('button', { name: '移到回收站' }).click();
  await page.getByRole('dialog', { name: '移到回收站？' }).getByRole('button', { name: '移到回收站' }).click();
  await expect(page.locator('.move-toast')).toContainText('已将 2 项移到回收站');
  await expect(list.locator('.node-list-main')).toHaveCount(0);
  await page.locator('.move-toast').getByRole('button', { name: '撤销', exact: true }).click();
  await expect(list.locator('.node-list-main')).toHaveCount(2);
});
