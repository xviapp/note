import { expect, test, type Locator } from './fixtures';
import { preparePassword } from '../shared/password';
import { paperHtml } from '../tests/fixtures/arxiv';

async function loadUntil(list: Locator, entry: Locator) {
  await expect(list).toHaveAttribute('aria-busy', 'false');
  for (let page = 0; page < 10 && !(await entry.count()); page++) {
    const more = list.locator(':scope > .load-more, :scope > li > .load-more');
    if (!(await more.count())) break;
    await more.click();
    await expect(list).toHaveAttribute('aria-busy', 'false');
  }
  await expect(entry).toBeAttached();
}

test('reopens a saved arXiv paper internally from the tree, lists, favorites and recent visits', async ({
  page,
  baseURL,
}, info) => {
  const headers = { origin: new URL(baseURL!).origin };
  const status = await (await page.request.get('/api/auth/status')).json();
  const auth = await page.request.post(status.initialized ? '/api/auth/login' : '/api/auth/setup', {
    headers,
    data: status.initialized
      ? { password: await preparePassword('Note2026', status.password) }
      : {
          password: await preparePassword('Note2026'),
          token: 'e2e-test-only-setup-token-never-deploy-0001',
        },
  });
  expect(auth.ok()).toBe(true);
  const create = async (data: object) => {
    const response = await page.request.post('/api/nodes', { headers, data });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const paper = await create({
    kind: 'link',
    title: `已导入的论文 · ${info.project.name}`,
    url: 'https://arxiv.org/html/2503.01800v1',
  });
  const other = await create({
    kind: 'markdown',
    title: `另一篇笔记 · ${info.project.name}`,
    content: '普通笔记正文。',
  });
  const link = await create({
    kind: 'link',
    title: `未导入的 arXiv 链接 · ${info.project.name}`,
    url: paper.url,
  });
  await page.request.put(`/api/nodes/${paper.id}/favorite`, { headers, data: { enabled: true } });
  // Model the persisted import response; the Worker import suite verifies these fields
  // from D1/R2. Browsing the paper never needs an external request in this fixture.
  await page.route('**/api/nodes**', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.method() !== 'GET') return route.fallback();
    if (url.pathname === `/api/nodes/${paper.id}`) {
      const response = await route.fetch(),
        detail = await response.json();
      return route.fulfill({
        json: { ...detail, arxiv_id: '2503.01800v1', content: paperHtml, attachments: [] },
      });
    }
    if (url.pathname === '/api/nodes') {
      const response = await route.fetch(),
        result = await response.json();
      return route.fulfill({
        json: {
          ...result,
          nodes: result.nodes.map((node: any) =>
            node.id === paper.id ? { ...node, arxiv_id: '2503.01800v1' } : node,
          ),
        },
      });
    }
    return route.fallback();
  });
  await page.goto(`/n/${paper.id}`);
  await expect(page.locator('.paper-body')).toContainText('Reading a mathematical paper.');
  await page.goto(`/n/${other.id}`);
  await expect(page.locator('.read-content')).toContainText('普通笔记正文。');
  await page.evaluate(() => {
    (window as any).openedUrls = [];
    window.open = (url) => {
      (window as any).openedUrls.push(String(url));
      return null;
    };
  });
  const drawer = page.getByRole('button', { name: '打开笔记目录', exact: true });
  if (await drawer.isVisible()) await drawer.click();
  await loadUntil(
    page.getByRole('tree'),
    page.getByRole('tree').getByRole('button', { name: paper.title, exact: true }),
  );
  await page.getByRole('tree').getByRole('button', { name: paper.title, exact: true }).click();
  expect(await page.evaluate(() => (window as any).openedUrls)).toEqual([]);
  await expect(page).toHaveURL(`/n/${paper.id}`);
  await expect(page.locator('.paper-body')).toContainText('Reading a mathematical paper.');
  await expect(page.locator('.external-link')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.paper-body')).toContainText('Reading a mathematical paper.');
  await page.evaluate(() => {
    (window as any).openedUrls = [];
    window.open = (url) => {
      (window as any).openedUrls.push(String(url));
      return null;
    };
  });
  for (const name of ['全部笔记', '收藏', '最近访问']) {
    if (await drawer.isVisible()) await drawer.click();
    await page.locator('.main-nav').getByRole('button', { name, exact: true }).click();
    const entry = page.locator('.node-list-main').filter({ hasText: paper.title });
    await loadUntil(page.locator('.node-list'), entry);
    await expect(entry).toContainText('arXiv 论文 · 2503.01800v1');
    await entry.click();
    expect(await page.evaluate(() => (window as any).openedUrls)).toEqual([]);
    await expect(page).toHaveURL(`/n/${paper.id}`);
    await expect(page.locator('.paper-body')).toContainText('Reading a mathematical paper.');
  }
  if (await drawer.isVisible()) await drawer.click();
  await loadUntil(
    page.getByRole('tree'),
    page.getByRole('tree').getByRole('button', { name: link.title, exact: true }),
  );
  await page.getByRole('tree').getByRole('button', { name: link.title, exact: true }).click();
  expect(await page.evaluate(() => (window as any).openedUrls)).toEqual([link.url]);
  await expect(page.locator('.paper-body')).toContainText('Reading a mathematical paper.');
  await page.screenshot({ path: info.outputPath('reopened-paper.png') });
});
