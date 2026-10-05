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
  const folder = await create(page, { kind: 'folder', title: `资料夹 ${name}` });
  const right = await create(page, {
    kind: 'markdown',
    title: `右边资料 ${name}`,
    parentId: folder.id,
    content: long('右边'),
  });
  await page.goto(`/n/${left.id}`);
  const menu = page.locator('.note-actions .node-menu');
  await menu.getByRole('button', { name: `管理 ${left.title}`, exact: true }).click();
  await menu.getByRole('button', { name: '分屏查看', exact: true }).click();
  const view = page.getByRole('dialog', { name: '分屏查看' });
  // The empty side lists the library: step into a folder, then pick the file.
  const picker = view.getByRole('region', { name: '未选择文件' });
  const row = (title: string) => picker.locator('.node-list-main').filter({ hasText: title });
  await row(folder.title).click();
  await expect(picker.getByRole('navigation', { name: '当前位置' })).toContainText(folder.title);
  await row(right.title).click();
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

  // Either side can be swapped: the pane lists files again, with a title filter.
  await leftPane.getByRole('button', { name: '换一份' }).click();
  await leftPane.getByRole('textbox', { name: '按标题查找文件' }).fill(`右边 ${name}`);
  await leftPane.getByRole('button', { name: new RegExp(right.title) }).click();
  if (name === 'desktop')
    await expect(view.getByRole('region', { name: right.title })).toHaveCount(2);
  else await expect(view.getByRole('button', { name: `左：${right.title}` })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(view).toHaveCount(0);
});

test('split panes follow note links, enlarge images, remember the pairing and can scroll together', async ({
  page,
}, info) => {
  await login(page);
  const name = info.project.name;
  const target = await create(page, {
    kind: 'markdown',
    title: `链接目标 ${name}`,
    content: long('目标'),
  });
  const left = await create(page, {
    kind: 'markdown',
    title: `带链接 ${name}`,
    content: `[打开目标](/n/${target.id})\n\n${long('左边')}`,
  });
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  const upload = await page.request.post(`/api/files?name=dot.png&size=${png.length}`, {
    headers,
    data: png,
  });
  const image = await create(page, {
    kind: 'image',
    title: `一张图 ${name}`,
    fileId: (await upload.json()).id,
  });
  const open = async () => {
    await page.goto(`/n/${left.id}`);
    const menu = page.locator('.note-actions .node-menu');
    await menu.getByRole('button', { name: `管理 ${left.title}`, exact: true }).click();
    await menu.getByRole('button', { name: '分屏查看', exact: true }).click();
    return page.getByRole('dialog', { name: '分屏查看' });
  };
  let view = await open();
  const picker = view.getByRole('region', { name: '未选择文件' });
  await picker.locator('.node-list-main').filter({ hasText: image.title }).click();
  // The image enlarges in the viewer.
  await view.getByRole('button', { name: `放大图片：${image.title}` }).click();
  await expect(page.getByRole('dialog', { name: image.title })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: image.title })).toHaveCount(0);

  // A link inside a note opens the linked note in that same pane.
  if (name === 'mobile') await view.getByRole('button', { name: `左：${left.title}` }).click();
  await view
    .getByRole('region', { name: left.title })
    .getByRole('link', { name: '打开目标' })
    .click();
  await expect(
    view.getByRole('region', { name: target.title }).getByRole('heading', { name: '目标 第 1 节' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(view).toHaveCount(0);

  // Reopening pairs the note with the file shown beside it last time.
  view = await open();
  await expect(view.getByRole('region', { name: image.title })).toHaveCount(1);
  await expect(view.getByRole('region', { name: '未选择文件' })).toHaveCount(0);

  if (name === 'desktop') {
    // Synced scrolling moves the other side by the same proportion.
    await view
      .getByRole('region', { name: image.title })
      .getByRole('button', { name: '换一份' })
      .click();
    await view.locator('.split-picker .node-list-main').filter({ hasText: target.title }).click();
    await view.getByRole('checkbox', { name: '同步滚动' }).check();
    const panes = view.locator('.split-scroll');
    await panes.first().evaluate((element) => {
      element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
    });
    await expect
      .poll(() =>
        panes.nth(1).evaluate((e) => e.scrollTop / Math.max(1, e.scrollHeight - e.clientHeight)),
      )
      .toBeCloseTo(0.5, 1);
    await page.keyboard.press('Escape');
    // The ? key lists the shortcuts.
    await page.locator('.read-content').click();
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: '快捷键' })).toContainText('Ctrl K 或 /');
  }
});
