import { noteAction } from './note-actions';
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

test('rows with children expand in place on the home list and show arrows only when needed', async ({
  page,
}, info) => {
  await login(page);
  const name = info.project.name;
  const paper = await create(page, { kind: 'markdown', title: `有下级 ${name}` });
  const child = await create(page, { kind: 'markdown', title: `下级 ${name}`, parentId: paper.id });
  await create(page, { kind: 'markdown', title: `另一下级 ${name}`, parentId: paper.id });
  const grandchild = await create(page, {
    kind: 'markdown',
    title: `再下级 ${name}`,
    parentId: child.id,
  });
  const plain = await create(page, { kind: 'markdown', title: `无下级 ${name}` });
  await page.goto('/');
  const list = page.locator('.library-home .node-list');
  // A row's accessible name also carries its type and date; find it by title.
  const row = (scope: typeof list, title: string) =>
    scope.locator('.node-list-main').filter({ has: page.getByText(title, { exact: true }) });
  await expect(row(list, plain.title)).toBeVisible();
  await expect(list.getByRole('button', { name: `展开 ${plain.title}` })).toHaveCount(0);
  const toggle = list.getByRole('button', { name: `展开 ${paper.title}`, exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  await toggle.click();
  const children = list.locator('.node-list-children').first();
  await expect(row(children, child.title)).toBeVisible();
  await expect(
    list.getByRole('button', { name: `收起 ${paper.title}`, exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await children.getByRole('button', { name: `展开 ${child.title}`, exact: true }).click();
  await expect(row(children, grandchild.title)).toBeVisible();
  await page.screenshot({ path: `.wrangler/node-list-expand-${name}.png` });

  await list.getByRole('button', { name: `收起 ${paper.title}`, exact: true }).click();
  await expect(list.locator('.node-list-children')).toHaveCount(0);

  if (name === 'desktop') {
    // The sidebar tree follows the same rule.
    const tree = page.locator('.sidebar-tree');
    await expect(tree.getByRole('button', { name: plain.title, exact: true })).toBeVisible();
    await expect(tree.getByRole('button', { name: `展开 ${plain.title}` })).toHaveCount(0);
    await expect(
      tree.getByRole('button', { name: `展开 ${paper.title}`, exact: true }),
    ).toBeVisible();
  }

  // Opening a nested row still navigates to it.
  await toggle.click();
  await row(list, child.title).click();
  await expect(page).toHaveURL(new RegExp(`/n/${child.id}$`));
});

test('a note opens its children from the toolbar, while a folder lists them on the page', async ({
  page,
}, info) => {
  await login(page);
  const name = info.project.name;
  const folder = await create(page, { kind: 'folder', title: `目录 ${name}` });
  const note = await create(page, {
    kind: 'markdown',
    title: `带下级的笔记 ${name}`,
    parentId: folder.id,
    content: '# 正文',
  });
  const child = await create(page, {
    kind: 'markdown',
    title: `子笔记 ${name}`,
    parentId: note.id,
  });
  await create(page, { kind: 'markdown', title: `另一子笔记 ${name}`, parentId: note.id });

  await page.goto(`/n/${note.id}`);
  await expect(page.getByRole('heading', { name: note.title, exact: true })).toBeVisible();
  await expect(page.locator('.children-section')).toHaveCount(0);
  // The outline stays on the toolbar; child notes move into the phone menu.
  const actions = page.locator('.note-actions');
  await expect(actions.locator('.has-badge + .toc-toggle')).toBeVisible();
  await noteAction(page, '下级笔记（2）');
  const dialog = page.getByRole('dialog', { name: '下级笔记（2）', exact: true });
  await expect(dialog.locator('.node-list-main')).toHaveCount(2);
  await dialog
    .locator('.node-list-main')
    .filter({ has: page.getByText(child.title, { exact: true }) })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/n/${child.id}$`));

  await page.goto(`/n/${folder.id}`);
  await expect(
    page.locator('.children-section .node-list-main').filter({ hasText: note.title }),
  ).toBeVisible();
});

test('child dialog keeps display controls in its header and fits every theme and phone width', async ({ page }, info) => {
  await login(page);
  const note = await create(page, { kind: 'markdown', title: '阅读与学习', content: '# 阅读笔记' });
  const folder = await create(page, { kind: 'folder', title: '学习资料', parentId: note.id });
  await create(page, { kind: 'markdown', title: '本周阅读清单', parentId: folder.id });
  await create(page, { kind: 'markdown', title: '读书时留下的想法与问题', parentId: folder.id });
  await page.goto(`/n/${note.id}`);
  await noteAction(page, '下级笔记（1）');
  const dialog = page.getByRole('dialog', { name: '下级笔记（1）', exact: true });
  await expect(dialog.locator('.node-list-main')).toHaveCount(1);
  await expect(dialog.locator('.node-list > .list-controls')).toHaveCount(0);
  if (info.project.name === 'desktop') {
    const header = dialog.locator('.modal-heading');
    await expect(header.getByLabel('列表排序')).toBeVisible();
    await header.getByLabel('列表排序').selectOption('title');
    await expect(dialog.locator('.node-list-main')).toHaveCount(1);
    await header.getByRole('button', { name: '紧凑列表', exact: true }).click();
    await expect(dialog.locator('.node-list-main small')).toBeHidden();
    await header.getByRole('button', { name: '紧凑列表', exact: true }).click();
  } else {
    await expect(dialog.locator('.list-controls')).toBeHidden();
  }
  for (const theme of ['light', 'dark', 'starry']) {
    await page.evaluate((value) => window.dispatchEvent(new StorageEvent('storage', { key: 'note:theme', newValue: value })), theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await dialog.screenshot({ path: `test-results/children-dialog-${theme}-${info.project.name}.png` });
  }
  await dialog.getByRole('button', { name: '展开 学习资料', exact: true }).click();
  await expect(dialog.locator('.node-list-children .node-list-main')).toHaveCount(2);
  await dialog.screenshot({ path: `test-results/children-dialog-expanded-${info.project.name}.png` });
  if (info.project.name === 'mobile') {
    await page.setViewportSize({ width: 320, height: 740 });
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeInViewport();
  }
});
