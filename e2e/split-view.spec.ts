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
const long = (name: string) =>
  Array.from(
    { length: 6 },
    (_, i) => `## ${name} 第 ${i + 1} 节\n\n${`${name}的正文，用来撑开页面高度。\n\n`.repeat(12)}`,
  ).join('\n');

test('two notes open side by side, each with its own scroll and outline', async ({
  page,
}, info) => {
  await login(page);
  const name = info.project.name;
  const left = await create(page, {
    kind: 'markdown',
    title: `左边笔记 ${name}`,
    content: long('左边'),
  });
  const right = await create(page, {
    kind: 'markdown',
    title: `右边资料 ${name}`,
    content: long('右边'),
  });
  // A folder with a matching title cannot be shown in a split, so it is not offered.
  await create(page, { kind: 'folder', title: `右边资料夹 ${name}` });
  await page.goto(`/n/${left.id}`);
  const menu = page.locator('.note-actions .node-menu');
  await menu.getByRole('button', { name: `管理 ${left.title}`, exact: true }).click();
  await menu.getByRole('button', { name: '分屏查看', exact: true }).click();
  const view = page.getByRole('dialog', { name: '分屏查看' });
  const picker = page.getByRole('dialog', { name: '选择右侧文件' });
  await picker.getByRole('combobox', { name: '搜索笔记标题' }).fill(`右边 ${name}`);
  await expect(picker.getByRole('option')).toHaveCount(1);
  await expect(picker.getByRole('option')).toContainText(right.title);
  // The picker sits above the split view, so the mouse reaches it.
  await picker.getByRole('button', { name: '关闭' }).click();
  await expect(picker).toHaveCount(0);
  // Phones show one side at a time; the empty right side has its own button.
  if (name === 'mobile') await view.getByRole('button', { name: '右', exact: true }).click();
  await view.getByRole('button', { name: '选择文件', exact: true }).click();
  await picker.getByRole('combobox', { name: '搜索笔记标题' }).fill(`右边 ${name}`);
  await picker.getByRole('option').filter({ hasText: right.title }).click();
  await expect(picker).toHaveCount(0);

  const leftPane = view.getByRole('region', { name: left.title });
  const rightPane = view.getByRole('region', { name: right.title });
  if (name === 'mobile') {
    // One side at a time; the side just chosen is shown.
    await expect(rightPane.getByRole('heading', { name: '右边 第 1 节' })).toBeVisible();
    await expect(leftPane).toBeHidden();
    await view.getByRole('button', { name: `左：${left.title}` }).click();
  } else await expect(rightPane.getByRole('heading', { name: '右边 第 1 节' })).toBeVisible();
  await expect(leftPane.getByRole('heading', { name: '左边 第 1 节' })).toBeVisible();

  const scrollTop = (pane: typeof leftPane) =>
    pane.locator('.split-scroll').evaluate((element) => element.scrollTop);
  await leftPane.getByRole('button', { name: `${left.title}的目录` }).click();
  await leftPane
    .getByRole('navigation', { name: `${left.title}的目录` })
    .getByRole('button', { name: '左边 第 5 节' })
    .click();
  await expect(leftPane.getByRole('heading', { name: '左边 第 5 节' })).toBeInViewport();
  expect(await scrollTop(leftPane)).toBeGreaterThan(500);
  if (name === 'desktop') expect(await scrollTop(rightPane)).toBe(0);
  else await expect(leftPane.getByRole('navigation')).toHaveCount(0);

  // Either side can be swapped for another file.
  await leftPane.getByRole('button', { name: '换一份' }).click();
  await expect(page.getByRole('dialog', { name: '选择左侧文件' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(view).toHaveCount(0);
});
