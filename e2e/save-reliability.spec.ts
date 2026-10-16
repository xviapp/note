import { expect, test, type Page } from './fixtures';
import { preparePassword } from '../shared/password';
import { writeSource } from './notebook-helpers';

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
  expect(response.ok()).toBe(true);
}
async function create(page: Page, data: object) {
  const response = await page.request.post('/api/nodes', { headers, data });
  expect(response.ok()).toBe(true);
  return response.json();
}

test('a late storage response preserves a quota typed before it arrives', async ({ page }) => {
  await login(page);
  const storage = await (await page.request.get('/api/storage')).json();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/storage', async (route) => {
    const response = await route.fetch();
    await pending;
    await route.fulfill({ response });
  });
  await page.goto('/settings/storage');
  const field = page.getByLabel('容量上限 GB', { exact: true });
  const nextQuota = storage.quotaBytes + 1e9;
  await field.fill(String(nextQuota / 1e9));
  release();
  await expect(page.getByRole('progressbar')).toBeVisible();
  await expect(field).toHaveValue(String(nextQuota / 1e9));
  try {
    await page.getByRole('button', { name: '更新上限', exact: true }).click();
    await expect
      .poll(async () => (await (await page.request.get('/api/storage')).json()).quotaBytes)
      .toBe(nextQuota);
  } finally {
    await page.request.patch('/api/settings', { headers, data: { quotaBytes: storage.quotaBytes } });
  }
});

test('pending photo uploads show visible feedback in every theme', async ({ page }, testInfo) => {
  await login(page);
  const journal = await create(page, { kind: 'folder', title: '照片上传', journal: true });
  const response = await page.request.post(`/api/nodes/${journal.id}/journal/entries`, {
    headers, data: { date: '2026-10-09', content: '# 日记' },
  });
  expect(response.ok()).toBe(true);
  const { node } = await response.json();
  await page.goto(`/n/${node.id}`);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/files?*', async (route) => {
    await gate;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '上传失败，请重试。' }) });
  });
  await page.getByLabel('添加照片').setInputFiles({ name: '照片.png', mimeType: 'image/png', buffer: Buffer.from('image') });
  const status = page.locator('.upload-status');
  try {
    for (const theme of ['light', 'dark', 'starry']) {
      await page.evaluate((value) => {
        window.dispatchEvent(new StorageEvent('storage', { key: 'note:theme', newValue: value }));
      }, theme);
      await expect(status).toHaveText('正在上传 1 张照片…');
      await expect(status).toBeInViewport();
      await expect(status.locator('.spin')).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`upload-${theme}.png`) });
    }
  } finally {
    release();
  }
  await expect(status).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('有张照片没传上去');
  await expect(page.getByLabel('添加照片')).toBeEnabled();
});

test('Save returns to the note at once and finishes in the background', async ({ page }) => {
  await login(page);
  const node = await create(page, { kind: 'markdown', title: '后台保存', content: '原文' });
  await page.goto(`/n/${node.id}`);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await writeSource(page, '后台提交的正文');
  await expect(page.locator('.editing-label')).toHaveText('草稿已存本机');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/nodes/${node.id}/content`, async (route) => {
    await gate;
    await route.continue();
  });
  await page.getByRole('button', { name: '保存', exact: true }).click();
  // The editor closes while the request is still held.
  await expect(page.getByRole('textbox', { name: 'Markdown 源码' })).toHaveCount(0);
  await expect(page.locator('.read-content')).toContainText('后台提交的正文');
  await expect(page.locator('.sync-status')).toContainText('1 项已存本机，等待同步');
  await expect(page.locator('.sync-status')).toBeInViewport();
  release();
  await expect(page.locator('.sync-status')).toHaveCount(0);
  await expect(page.getByText('正文已同步', { exact: true })).toBeVisible();
  await expect.poll(async () => (await (await page.request.get(`/api/nodes/${node.id}`)).json()).content).toBe('后台提交的正文');
  await expect.poll(() => page.evaluate((id) => localStorage.getItem(`note-draft:${id}`), node.id)).toBeNull();
  await page.reload();
  await expect(page.locator('.read-content')).toContainText('后台提交的正文');
  await expect(page.getByRole('button', { name: '恢复草稿', exact: true })).toHaveCount(0);
});

test('a failed local draft stays in the editor and never claims to be stored', async ({ page }) => {
  await login(page);
  const node = await create(page, { kind: 'markdown', title: '本机草稿状态', content: '原文' });
  await page.goto(`/n/${node.id}`);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await expect(page.locator('.editing-label')).toHaveText('已同步');
  await page.evaluate((id) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === `note-draft:${id}`) throw new DOMException('Storage full', 'QuotaExceededError');
      original.call(this, key, value);
    };
  }, node.id);
  await writeSource(page, '没有写进本机存储的修改');
  await expect(page.locator('.editing-label')).toHaveText('草稿暂存失败');
  await expect(page.locator('.draft-warning')).toBeVisible();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.save-error')).toContainText('无法在本机暂存正文');
  await expect(page.getByRole('textbox', { name: 'Markdown 源码' })).toContainText('没有写进本机存储的修改');
  expect(await page.evaluate((id) => localStorage.getItem(`note-draft:${id}`), node.id)).toBeNull();
  expect((await (await page.request.get(`/api/nodes/${node.id}`)).json()).content).toBe('原文');
});

// Ctrl+S keeps editing, so it still waits for the new revision.
test('typing during Ctrl+S survives completion and reload', async ({ page }) => {
  await login(page);
  const node = await create(page, { kind: 'markdown', title: '保存中的草稿', content: '原文' });
  await page.goto(`/n/${node.id}`);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown 源码' });
  await writeSource(page, '提交的正文');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/nodes/${node.id}/content`, async (route) => {
    await gate;
    await route.continue();
  });
  const sent = page.waitForRequest((request) => request.method() === 'PUT' && request.url().endsWith('/content'));
  await source.press('ControlOrMeta+s');
  await sent;
  const latest = '提交的正文\n请求期间新增的内容';
  await writeSource(page, latest);
  await expect.poll(() => page.evaluate((id) => localStorage.getItem(`note-draft:${id}`), node.id)).toContain('请求期间新增');
  release();
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await expect(source).toContainText('请求期间新增');
  await expect.poll(async () => (await (await page.request.get(`/api/nodes/${node.id}`)).json()).content).toBe('提交的正文');
  await expect.poll(() => page.evaluate((id) => localStorage.getItem(`note-draft:${id}`), node.id)).toContain('请求期间新增');
  page.on('dialog', (dialog) => void dialog.accept());
  await page.reload();
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await expect(source).toContainText('请求期间新增');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(source).toHaveCount(0);
  await expect(page.locator('.read-content')).toContainText('请求期间新增');
});

test('a committed append with a lost response is not duplicated after reopening', async ({ page }) => {
  await login(page);
  const journal = await create(page, { kind: 'folder', title: '重试日记', journal: true });
  const response = await page.request.post(`/api/nodes/${journal.id}/journal/entries`, {
    headers, data: { date: '2026-10-09', content: '# 日记\n\n原文' },
  });
  expect(response.ok()).toBe(true);
  const { node } = await response.json();
  await page.goto(`/n/${node.id}`);
  const field = page.getByLabel('记录内容');
  await field.fill('只追加一次的记录');
  await page.route(`**/api/nodes/${node.id}/content`, async (route) => {
    const committed = await route.fetch();
    expect(committed.ok()).toBe(true);
    await route.fulfill({ status: 503, json: { error: '模拟提交后的响应丢失' } });
  }, { times: 1 });
  await page.getByRole('button', { name: '追加', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('模拟提交后的响应丢失');
  await page.reload();
  await expect(field).toHaveValue('只追加一次的记录');
  await page.getByRole('button', { name: '重试追加', exact: true }).click();
  await expect(field).toHaveValue('');
  const saved = await (await page.request.get(`/api/nodes/${node.id}`)).json();
  expect(saved.content.match(/只追加一次的记录/g)).toHaveLength(1);
});

test('failed searches cannot open results from a different query', async ({ page }) => {
  await login(page);
  await create(page, { kind: 'markdown', title: '甲搜索测试' });
  await create(page, { kind: 'markdown', title: '乙搜索测试' });
  await page.goto('/');
  await page.locator('.app-header').getByRole('button', { name: '搜索笔记' }).click();
  const dialog = page.getByRole('dialog', { name: '搜索笔记', exact: true });
  const field = dialog.getByRole('combobox', { name: '搜索笔记标题、正文或批注' });
  await field.fill('甲搜索测试');
  await expect(dialog.getByRole('listbox', { name: '搜索结果' }).getByRole('option')).toHaveCount(1);
  await page.route('**/api/search?q=*', (route) => route.fulfill({ status: 503, json: { error: '搜索暂时失败' } }), { times: 1 });
  await field.fill('乙搜索测试');
  // Only this device's titles for the current query remain, marked as such.
  await expect(dialog.locator('.search-caption')).toHaveText('搜索暂时失败，先显示已找到的');
  await expect(dialog.getByRole('listbox', { name: '搜索结果' }).getByRole('option')).toHaveText(['乙搜索测试']);
});

test('an unsubmitted clip survives closing and reloading without being sent', async ({ page }) => {
  await login(page);
  await page.goto('/');
  const open = () => page.locator('.app-header').getByRole('button', { name: '随手记' }).click();
  await open();
  const field = page.getByLabel('随手记内容');
  await field.fill('尚未提交的随手记');
  await page.keyboard.press('Escape');
  await page.reload();
  await open();
  await expect(field).toHaveValue('尚未提交的随手记');
  const clips = await (await page.request.get('/api/clips')).json();
  expect(clips.items).toHaveLength(0);
});

test('encrypted clip drafts stay sealed and return after unlocking', async ({ page }) => {
  await login(page);
  await page.goto('/');
  const open = () => page.locator('.app-header').getByRole('button', { name: '随手记' }).click();
  await open();
  const dialog = page.getByRole('dialog', { name: '随手记', exact: true });
  await page.evaluate(() => localStorage.setItem('note:key-policy', 'session'));
  await dialog.getByRole('button', { name: '加密设置' }).click();
  await dialog.getByLabel('密码', { exact: true }).fill('draft-secret');
  await dialog.getByLabel('再次输入').fill('draft-secret');
  await dialog.getByRole('button', { name: '设置密码' }).click();
  const field = dialog.getByLabel('随手记内容');
  await field.fill('只在本机解密的草稿');
  const stored = () => page.evaluate(() => localStorage.getItem('note-draft:clips-compose'));
  await expect.poll(stored).toContain('sealed');
  expect(await stored()).not.toContain('只在本机解密');
  await page.keyboard.press('Escape');
  await page.reload();
  await open();
  await dialog.getByLabel('密码', { exact: true }).fill('draft-secret');
  await dialog.getByRole('button', { name: '解锁', exact: true }).click();
  await expect(field).toHaveValue('只在本机解密的草稿');
  expect(await stored()).not.toContain('只在本机解密');
});

test('creation and editing layouts fit all themes and keep header action gaps equal', async ({ page }, testInfo) => {
  await login(page);
  const widths = testInfo.project.name === 'mobile' ? [390, 320] : [1440];
  for (const width of widths) {
    await page.setViewportSize({ width, height: width < 400 ? 844 : 960 });
    for (const theme of ['light', 'dark', 'starry']) {
      await page.goto('/');
      await page.evaluate((value) => {
        localStorage.setItem('note:theme', value);
        window.dispatchEvent(new StorageEvent('storage', { key: 'note:theme', newValue: value }));
      }, theme);
      const header = page.locator('.app-header');
      const boxes = await Promise.all(['搜索笔记', '随手记', '新建'].map((name) => header.getByRole('button', { name, exact: true }).boundingBox()));
      const [search, clips, create] = boxes.map((box) => box!);
      expect(clips.x - search.x - search.width).toBeCloseTo(create.x - clips.x - clips.width, 0);
      await page.getByRole('button', { name: '创建笔记', exact: true }).click();
      const form = page.getByRole('dialog', { name: '新建笔记', exact: true });
      await expect(form.getByRole('radio')).toHaveCount(4);
      await expect(form.getByRole('radio').first()).toBeChecked();
      await page.screenshot({ path: testInfo.outputPath(`create-${width}-${theme}.png`) });
      await form.getByRole('button', { name: '更多类型' }).click();
      await expect(form.getByRole('radio')).toHaveCount(11);
      await form.getByRole('button', { name: '取消', exact: true }).click();
    }
  }
  const node = await create(page, { kind: 'markdown', title: '窄屏编辑', content: '正文' });
  for (const width of widths) {
    await page.setViewportSize({ width, height: width < 400 ? 844 : 960 });
    await page.goto(`/n/${node.id}`);
    await page.getByRole('button', { name: '编辑正文', exact: true }).click();
    await writeSource(page, '未提交正文');
    for (const theme of ['light', 'dark', 'starry']) {
      await page.evaluate((value) => {
        window.dispatchEvent(new StorageEvent('storage', { key: 'note:theme', newValue: value }));
      }, theme);
      await expect(page.locator('.editing-label')).toHaveText('草稿已存本机');
      const save = await page.getByRole('button', { name: '保存', exact: true }).boundingBox();
      const tabs = await (width < 400 ? page.locator('.edit-tabs') : page.getByRole('button', { name: '取消', exact: true })).boundingBox();
      expect(Math.abs(save!.y - tabs!.y)).toBeLessThan(6);
      expect(save!.x + save!.width).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(`edit-${width}-${theme}.png`) });
      if (width < 400) {
        await page.getByRole('button', { name: '更多编辑操作' }).click();
        const menu = await page.locator('.edit-insert-menu .menu-popup').boundingBox();
        expect(menu!.x).toBeGreaterThanOrEqual(0);
        expect(menu!.x + menu!.width).toBeLessThanOrEqual(width);
        await page.screenshot({ path: testInfo.outputPath(`menu-${width}-${theme}.png`) });
        await page.keyboard.press('Escape');
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
    await page.getByRole('button', { name: '取消', exact: true }).click();
    const discard = page.getByRole('button', { name: '放弃修改', exact: true });
    if (await discard.isVisible()) await discard.click();
  }
});
