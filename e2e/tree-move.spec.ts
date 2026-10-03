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
const parentOf = async (page: Page, id: string) =>
  (await (await page.request.get(`/api/nodes/${id}`)).json()).parent_id;

async function seed(page: Page, name: string) {
  // An icon on the target checks the move toast names the folder, not its icon.
  const target = await create(page, {
    kind: 'folder',
    title: `目标 ${name}`,
    icon: { emoji: '📚' },
  });
  const outer = await create(page, { kind: 'folder', title: `外层 ${name}` });
  const inner = await create(page, { kind: 'folder', title: `内层 ${name}`, parentId: outer.id });
  const note = await create(page, { kind: 'markdown', title: `待移动 ${name}` });
  return { target, outer, inner, note };
}
const center = async (page: Page, selector: string) => {
  const box = (await page.locator(selector).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const row = (id: string) => `[data-tree-node="${id}"]`;

test('desktop drag shows a card, valid targets, landing and undo', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'Sidebar tree with a mouse');
  await login(page);
  const { target, outer, inner, note } = await seed(page, info.project.name);
  await page.goto('/');
  const tree = page.locator('.sidebar-tree');
  await expect(tree.locator(row(note.id))).toBeVisible();

  const from = await center(page, `.sidebar-tree ${row(note.id)}`);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 4, { steps: 4 });
  const ghost = page.locator('.tree-drag-ghost');
  await expect(ghost).toContainText(note.title);
  await expect(tree.locator(`li.is-drag-source ${row(note.id)}`)).toBeVisible();
  // A note at the top level cannot move to the top level, nor onto itself.
  await expect(tree.locator('.section-label')).toContainText('我的笔记');
  await expect(page.locator('html')).toHaveAttribute('data-tree-drag', 'blocked');

  const onto = await center(page, `.sidebar-tree ${row(target.id)}`);
  await page.mouse.move(onto.x, onto.y, { steps: 6 });
  await expect(tree.locator(row(target.id))).toHaveClass(/is-drop-over/);
  await expect(page.locator('.tree-drag-card')).toHaveClass(/can-drop/);
  await page.screenshot({ path: `.wrangler/tree-move-${info.project.name}.png` });
  await page.mouse.up();
  await expect(ghost).toHaveCount(0);
  await expect.poll(() => parentOf(page, note.id)).toBe(target.id);
  // The drop does not also open the note under the pointer.
  await expect(page).toHaveURL(/\/$/);
  const toast = page.locator('.move-toast');
  await expect(toast).toContainText(`已移到「${target.title}」`);
  await expect(
    tree.getByRole('button', { name: `收起 ${target.title}`, exact: true }),
  ).toBeVisible();
  await expect(tree.locator(`[data-tree-item="${target.id}"] > ul ${row(note.id)}`)).toHaveClass(
    /is-landed/,
  );

  await toast.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(() => parentOf(page, note.id)).toBeNull();
  await expect(toast).toContainText('已撤销移动');
  await expect(tree.locator(`[role="tree"] > li > ${row(note.id)}`)).toBeVisible();

  // Escape cancels a drag in progress.
  const again = await center(page, `.sidebar-tree [role="tree"] > li > ${row(note.id)}`);
  await page.mouse.move(again.x, again.y);
  await page.mouse.down();
  const targetNow = await center(page, `.sidebar-tree ${row(target.id)}`);
  await page.mouse.move(targetNow.x, targetNow.y, { steps: 6 });
  await page.keyboard.press('Escape');
  await expect(ghost).toHaveCount(0);
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(await parentOf(page, note.id)).toBeNull();

  // Hovering a collapsed folder opens it, so a nested folder can be the target.
  const start = await center(page, `.sidebar-tree [role="tree"] > li > ${row(note.id)}`);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const over = await center(page, `.sidebar-tree ${row(outer.id)}`);
  await page.mouse.move(over.x, over.y, { steps: 6 });
  await expect(
    tree.getByRole('button', { name: `收起 ${outer.title}`, exact: true }),
  ).toBeVisible();
  const nested = await center(page, `.sidebar-tree ${row(inner.id)}`);
  await page.mouse.move(nested.x, nested.y, { steps: 4 });
  await expect(tree.locator(row(inner.id))).toHaveClass(/is-drop-over/);
  await page.mouse.up();
  await expect.poll(() => parentOf(page, note.id)).toBe(inner.id);
  // Wait for the top level to drop its copy before picking the note up again.
  await expect(tree.locator(`[role="tree"] > li > ${row(note.id)}`)).toHaveCount(0);

  // Once nested, the top level becomes a target.
  const nestedNote = await center(
    page,
    `.sidebar-tree [data-tree-item="${inner.id}"] > ul > li > ${row(note.id)}`,
  );
  await page.mouse.move(nestedNote.x, nestedNote.y);
  await page.mouse.down();
  const label = await center(page, '.sidebar-tree .tree > .section-label');
  await page.mouse.move(label.x, label.y, { steps: 6 });
  await expect(tree.locator('.section-label')).toHaveClass(/is-root-over/);
  await expect(tree.locator('.section-label')).toContainText('移到根目录');
  await page.mouse.up();
  await expect.poll(() => parentOf(page, note.id)).toBeNull();
  await expect(toast).toContainText('已移到根目录');

  // Moving into a folder under a collapsed one opens the whole way down.
  await tree.getByRole('button', { name: `收起 ${outer.title}`, exact: true }).click();
  await expect(tree.locator(row(inner.id))).toHaveCount(0);
  await tree
    .locator(`[role="tree"] > li > ${row(note.id)}`)
    .getByRole('button', { name: `管理 ${note.title}`, exact: true })
    .click();
  await tree.getByRole('button', { name: '移动到…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `移动「${note.title}」`, exact: true });
  await dialog.getByRole('button', { name: `进入 ${outer.title}`, exact: true }).click();
  await dialog.getByRole('button', { name: inner.title, exact: true }).click();
  await dialog.getByRole('button', { name: '确认移动', exact: true }).click();
  await expect.poll(() => parentOf(page, note.id)).toBe(inner.id);
  await expect(
    tree.getByRole('button', { name: `收起 ${outer.title}`, exact: true }),
  ).toBeVisible();
  await expect(tree.locator(`[data-tree-item="${inner.id}"] > ul ${row(note.id)}`)).toBeVisible();
  // The reveal plays once; returning to the page later does not replay it.
  await page.waitForTimeout(3800);
  await page.goto('/favorites');
  await page.goto('/');
  await expect(tree.locator('.is-landed, .is-drop-done')).toHaveCount(0);
});

test('Android long press picks up a note, and a quick swipe still scrolls', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'mobile', 'Touch on the Android home tree');
  await page.addInitScript(() => {
    (window as any).androidBridge = {};
  });
  await login(page);
  const { target, note } = await seed(page, info.project.name);
  await page.goto('/');
  const tree = page.locator('.library-home .tree');
  await expect(tree.locator(row(note.id))).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: string, point?: { x: number; y: number }) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: point ? [{ x: point.x, y: point.y }] : [],
    });
  const from = await center(page, `.library-home ${row(note.id)}`);
  const onto = await center(page, `.library-home ${row(target.id)}`);
  const ghost = page.locator('.tree-drag-ghost');

  // Moving before the long press completes is a scroll, not a drag.
  await touch('touchStart', from);
  await touch('touchMove', { x: from.x, y: from.y - 30 });
  await page.waitForTimeout(450);
  await expect(ghost).toHaveCount(0);
  await touch('touchEnd');
  expect(await parentOf(page, note.id)).toBeNull();

  await touch('touchStart', from);
  await page.waitForTimeout(450);
  await expect(ghost).toHaveClass(/is-touch/);
  await expect(page.locator('.pull-refresh')).toHaveCount(0);
  for (let step = 1; step <= 6; step++)
    await touch('touchMove', {
      x: from.x + ((onto.x - from.x) * step) / 6,
      y: from.y + ((onto.y - from.y) * step) / 6,
    });
  await expect(tree.locator(row(target.id))).toHaveClass(/is-drop-over/);
  await page.screenshot({ path: `.wrangler/tree-move-android.png` });
  await touch('touchEnd');
  await expect(ghost).toHaveCount(0);
  await expect.poll(() => parentOf(page, note.id)).toBe(target.id);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.move-toast')).toContainText(`已移到「${target.title}」`);
  await expect(page.locator('.pull-refresh')).toHaveCount(0);
});
