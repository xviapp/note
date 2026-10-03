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
