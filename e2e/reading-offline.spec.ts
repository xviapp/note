import { test, expect, type Page } from '@playwright/test';
import { preparePassword } from '../shared/password';
import { paperHtml, paperPng } from '../tests/fixtures/arxiv';

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
async function nav(page: Page, name: string, section = '离线缓存') {
  const drawer = page.getByRole('button', { name: '打开笔记目录', exact: true });
  if (await drawer.isVisible()) await drawer.click();
  await page.locator('.main-nav').getByRole('button', { name, exact: true }).click();
  if (name === '设置')
    await page.locator('.settings-entry').getByText(section, { exact: true }).click();
}
async function pin(page: Page, title: string) {
  const menu = page.locator('.note-actions .node-menu');
  await menu.getByRole('button', { name: `管理 ${title}`, exact: true }).click();
  await menu.getByRole('button', { name: '离线保存', exact: true }).click();
  await expect(menu.getByRole('button', { name: '取消离线保存', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await page.keyboard.press('Escape');
}
async function cacheRecords(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('yejian-offline', 1);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const result = await new Promise<any[]>((resolve, reject) => {
      const request = db.transaction('notes').objectStore('notes').getAll();
      request.onsuccess = () =>
        resolve(
          request.result.map(({ detail, files, ...item }: any) => ({
            ...item,
            content: detail.content,
            title: detail.title,
            sizes: files.map((file: any) => file.blob.size),
          })),
        );
      request.onerror = () => reject(request.error);
    });
    db.close();
    return result;
  });
}
function pdfFixture() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...[1, 2, 3].flatMap((page, index) => {
      const stream = `BT /F1 22 Tf 30 450 Td (Offline page ${page}) Tj ET`;
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 520] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      ];
    }),
  ];
  let data = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(data));
    data += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(data);
  data += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(data);
}
async function upload(page: Page, name: string, data: Buffer) {
  const response = await page.request.post(
    `/api/files?name=${encodeURIComponent(name)}&size=${data.length}`,
    { headers, data },
  );
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test('reading preferences apply live, preserve formula/code spacing, and survive reload', async ({
  page,
}, info) => {
  await login(page);
  const note = await create(page, {
    title: '可调的阅读页',
    kind: 'markdown',
    content: '# 阅读\n\n把文字留在页间。\n\n$x^2 + y^2 = 1$\n\n`const page = 1`',
  });
  await page.goto(`/n/${note.id}`);
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '阅读设置' });
  await panel.getByText('宋体', { exact: true }).click();
  const size = panel.getByRole('slider', { name: '正文字号' });
  await size.focus();
  await size.press('End');
  await panel.getByRole('button', { name: '宽松', exact: true }).click();
  await panel.getByText('微调间距', { exact: true }).click();
  await expect(page.locator('.read-content .markdown-body')).toHaveCSS('font-size', '28px');
  await expect(page.locator('.read-content .markdown-body')).toHaveCSS('letter-spacing', '1.12px');
  await expect(page.locator('.read-content .markdown-body')).toHaveCSS('line-height', '61.6px');
  await expect(page.locator('.read-content .katex')).toHaveCSS('letter-spacing', 'normal');
  await expect(page.locator('.read-content code')).toHaveCSS('letter-spacing', 'normal');
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await page.screenshot({ path: `test-results/reading-settings-${info.project.name}.png` });
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.locator('.read-content .markdown-body')).toHaveCSS('font-size', '28px');
  await expect(page.locator('html')).toHaveAttribute('data-reading-font', 'serif');
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  await panel.getByRole('button', { name: '恢复默认' }).click();
  await expect(page.locator('.read-content .markdown-body')).toHaveCSS('font-size', '16px');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('cached Markdown, images, full PDF and progress survive a fresh offline page', async ({
  page,
  context,
}, info) => {
  test.setTimeout(100_000);
  await login(page);
  const image = await upload(page, 'offline.png', Buffer.from(paperPng, 'base64'));
  const pdf = await upload(page, 'offline.pdf', pdfFixture());
  const note = await create(page, {
    title: '随身阅读',
    kind: 'markdown',
    content: `# 离线手记\n\n断网也能打开。\n\n![插图](/api/files/${image.id})`,
    attachments: [image.id, pdf.id],
  });
  const pdfNode = await create(page, { title: '完整 PDF', kind: 'pdf', fileId: pdf.id });
  await page.goto(`/n/${note.id}`);
  await pin(page, note.title);
  await page.goto(`/n/${pdfNode.id}`);
  await expect(page.locator('.pdf-page').first()).toContainText('Offline page 1');
  await pin(page, pdfNode.title);
  const pageNumber = page.getByRole('spinbutton', { name: 'PDF 页码' });
  await pageNumber.fill('2');
  await pageNumber.press('Enter');
  await expect(page.locator('.pdf-page[data-page="2"]')).toContainText('Offline page 2');
  await expect
    .poll(
      async () => (await cacheRecords(page)).filter((item) => item.pinned && item.complete).length,
    )
    .toBe(2);
  const records = await cacheRecords(page);
  expect(records.find((item) => item.id === note.id)?.sizes).toContain(pdfFixture().length);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.offline-banner')).toBeVisible();
  await expect(pageNumber).toHaveValue('2');
  await pageNumber.fill('3');
  await pageNumber.press('Enter');
  await expect(page.locator('.pdf-page[data-page="3"]')).toContainText('Offline page 3');
  await page.screenshot({ path: `test-results/offline-pdf-${info.project.name}.png` });
  await nav(page, '离线阅读');
  await page
    .locator('.offline-library')
    .getByRole('button', { name: /随身阅读/ })
    .click();
  await expect(page.locator('.read-content')).toContainText('断网也能打开。');
  await expect
    .poll(() =>
      page.locator('.read-content img').evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: '编辑正文' })).toBeDisabled();
  await page.locator('.read-content img').click();
  await expect(page.getByRole('dialog').locator('img')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('.attachment-name').filter({ hasText: 'offline.pdf' }).click();
  await expect(page.getByRole('dialog').locator('.pdf-page').first()).toContainText(
    'Offline page 1',
  );
  await page.keyboard.press('Escape');
  await context.setOffline(false);
});

test('reconnect refreshes pinned content and a server deletion never falls back to stale data', async ({
  page,
  context,
}) => {
  test.setTimeout(100_000);
  await login(page);
  const note = await create(page, { title: '可更新的离线副本', kind: 'text', content: '第一版' });
  await page.goto(`/n/${note.id}`);
  await pin(page, note.title);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.plain-text')).toHaveText('第一版');
  const unlock = await (
    await page.request.post('/api/edit/unlock', { headers, data: { nodeId: note.id } })
  ).json();
  expect(
    (
      await page.request.put(`/api/nodes/${note.id}/content`, {
        headers: { ...headers, 'x-note-edit': unlock.token },
        data: { revision: note.revision, content: '第二版', attachments: [] },
      })
    ).ok(),
  ).toBe(true);
  await context.setOffline(false);
  await expect(page.locator('.offline-banner')).toHaveCount(0);
  await expect(page.locator('.plain-text')).toHaveText('第二版');
  await expect
    .poll(async () => (await cacheRecords(page)).find((item) => item.id === note.id)?.content)
    .toBe('第二版');
  const deletion = await page.request.delete(`/api/nodes/${note.id}`, {
    headers,
    data: { count: 1 },
  });
  expect(deletion.ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: '这篇笔记在回收站中' })).toBeVisible();
  await expect
    .poll(async () => (await cacheRecords(page)).some((item) => item.id === note.id))
    .toBe(false);
});

test('logout clears private offline snapshots across tabs and they cannot return offline', async ({
  page,
  context,
}) => {
  test.setTimeout(100_000);
  await login(page);
  const note = await create(page, {
    title: '退出后的私人笔记',
    kind: 'text',
    content: '不应在退出后出现的正文',
  });
  await page.goto(`/n/${note.id}`);
  await pin(page, note.title);
  const other = await context.newPage();
  await other.goto(`/n/${note.id}`);
  await expect(other.locator('.plain-text')).toHaveText(note.content || '不应在退出后出现的正文');
  await nav(page, '设置', '密码与设备');
  await page.getByRole('button', { name: '退出当前设备', exact: true }).click();
  await expect(page.locator('.auth-form')).toBeVisible();
  await expect(other.locator('.auth-form')).toBeVisible();
  await expect.poll(async () => (await cacheRecords(page)).length).toBe(0);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('button', { name: '重新连接', exact: true })).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveCount(0);
  await expect(page.getByText('不应在退出后出现的正文')).toHaveCount(0);
  await context.setOffline(false);
});

test('saved arXiv body and local figures remain readable offline', async ({ page, context }) => {
  test.setTimeout(100_000);
  await login(page);
  const image = await upload(page, 'figure.png', Buffer.from(paperPng, 'base64'));
  const paper = await create(page, {
    title: '离线论文',
    kind: 'link',
    url: 'https://arxiv.org/html/2503.01800v1',
  });
  await page.route(`**/api/nodes/${paper.id}`, async (route) => {
    const detail = await (await route.fetch()).json();
    await route.fulfill({
      json: {
        ...detail,
        arxiv_id: '2503.01800v1',
        content: `${paperHtml}<img src="/api/files/${image.id}" alt="论文插图" />`,
        attachments: [image],
      },
    });
  });
  await page.goto(`/n/${paper.id}`);
  await expect(page.locator('.paper-body')).toContainText('Reading a mathematical paper.');
  await pin(page, paper.title);
  await page.unroute(`**/api/nodes/${paper.id}`);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.paper-body')).toContainText('Reading a mathematical paper.');
  await page.locator('.paper-body img[alt="论文插图"]').scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      page
        .locator('.paper-body img[alt="论文插图"]')
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: '阅读设置', exact: true }).click();
  await page.getByRole('dialog').getByText('黑体', { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-reading-font', 'sans');
  await context.setOffline(false);
});

test('cache budget evicts automatic copies, protects pinned files and reports insufficient space', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page);
  const notes = await Promise.all(
    ['较早阅读', '保留的文件', '另一份大文件'].map((title) =>
      create(page, { title, kind: 'text', content: title }),
    ),
  );
  const payload = Buffer.alloc(26_000_000, 'x');
  await page.route('**/api/files/offline-large-*', (route) =>
    route.fulfill({
      status: 200,
      body: payload,
      headers: { 'content-type': 'text/plain', 'content-length': String(payload.length) },
    }),
  );
  await page.route('**/api/nodes/*', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    if (!notes.some((note) => note.id === id) || route.request().method() !== 'GET')
      return route.fallback();
    const detail = await (await route.fetch()).json();
    await route.fulfill({
      json: {
        ...detail,
        attachments: [
          { id: `offline-large-${id}`, name: '资料.txt', mime: 'text/plain', size: payload.length },
        ],
      },
    });
  });
  await page.goto(`/n/${notes[0].id}`);
  await expect
    .poll(
      async () =>
        (await cacheRecords(page)).some((item) => item.id === notes[0].id && item.complete),
      { timeout: 20_000 },
    )
    .toBe(true);
  await nav(page, '设置');
  await page.getByLabel('缓存上限', { exact: true }).selectOption('50000000');
  await page.goto(`/n/${notes[1].id}`);
  await pin(page, notes[1].title);
  await expect
    .poll(async () => (await cacheRecords(page)).map((item) => item.id))
    .toEqual([notes[1].id]);
  await page.goto(`/n/${notes[2].id}`);
  const menu = page.locator('.note-actions .node-menu');
  await menu.getByRole('button', { name: `管理 ${notes[2].title}` }).click();
  await menu.getByRole('button', { name: '离线保存', exact: true }).click();
  await expect(menu.getByRole('alert')).toContainText('本机缓存空间不足');
  expect((await cacheRecords(page)).map((item) => [item.id, item.pinned])).toEqual([
    [notes[1].id, true],
  ]);
  await page.keyboard.press('Escape');
  await nav(page, '设置');
  await page.getByLabel('缓存上限', { exact: true }).selectOption('100000000');
  await page.goto(`/n/${notes[2].id}`);
  await pin(page, notes[2].title);
  await nav(page, '设置');
  await page.getByLabel('缓存上限', { exact: true }).selectOption('50000000');
  await expect(page.locator('.cache-settings').getByRole('alert')).toContainText(
    '已离线保存的文件超过此上限',
  );
  await expect(page.getByLabel('缓存上限', { exact: true })).toHaveValue('100000000');
  await page.getByRole('button', { name: `取消离线保存 ${notes[2].title}` }).click();
  await page.getByRole('button', { name: '清理自动缓存' }).click();
  await expect
    .poll(async () => (await cacheRecords(page)).map((item) => [item.id, item.pinned]))
    .toEqual([[notes[1].id, true]]);
  expect((await page.request.get(`/api/nodes/${notes[2].id}`)).ok()).toBe(true);
});

test('an interrupted attachment refresh preserves the complete pinned snapshot until retry', async ({
  page,
  context,
}) => {
  test.setTimeout(100_000);
  await login(page);
  const note = await create(page, {
    title: '完整副本',
    kind: 'text',
    content: '已经完整保存的内容',
  });
  await page.goto(`/n/${note.id}`);
  await pin(page, note.title);
  const file = await upload(page, 'later.pdf', pdfFixture());
  const unlock = await (
    await page.request.post('/api/edit/unlock', { headers, data: { nodeId: note.id } })
  ).json();
  expect(
    (
      await page.request.put(`/api/nodes/${note.id}/content`, {
        headers: { ...headers, 'x-note-edit': unlock.token },
        data: { revision: note.revision, content: '带新附件的内容', attachments: [file.id] },
      })
    ).ok(),
  ).toBe(true);
  await page.route(`**/api/files/${file.id}`, (route) => route.abort('connectionfailed'));
  await page.reload();
  await expect(page.locator('.plain-text')).toHaveText('带新附件的内容');
  await expect
    .poll(async () => (await cacheRecords(page)).find((item) => item.id === note.id)?.error)
    .toBe('离线副本尚未更新');
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.plain-text')).toHaveText('已经完整保存的内容');
  await page.unroute(`**/api/files/${file.id}`);
  await context.setOffline(false);
  await expect
    .poll(async () => (await cacheRecords(page)).find((item) => item.id === note.id)?.content)
    .toBe('带新附件的内容');
  expect((await cacheRecords(page)).find((item) => item.id === note.id)).toMatchObject({
    complete: true,
    pinned: true,
    sizes: [pdfFixture().length],
  });
});

test('PDF reading automatically saves the full stream without a duplicate file download', async ({
  page,
  context,
}) => {
  test.setTimeout(100_000);
  await login(page);
  const bytes = pdfFixture();
  const file = await upload(page, 'streamed.pdf', bytes);
  const note = await create(page, { title: '自动缓存的 PDF', kind: 'pdf', fileId: file.id });
  const downloads: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === `/api/files/${file.id}` && request.method() === 'GET')
      downloads.push(request.url());
  });
  await page.goto(`/n/${note.id}`);
  await expect(page.locator('.pdf-page').first()).toContainText('Offline page 1');
  await expect
    .poll(async () => (await cacheRecords(page)).find((item) => item.id === note.id)?.complete)
    .toBe(true);
  expect((await cacheRecords(page)).find((item) => item.id === note.id)).toMatchObject({
    pinned: false,
    sizes: [bytes.length],
  });
  expect(downloads).toHaveLength(1);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('spinbutton', { name: 'PDF 页码' }).fill('3');
  await page.getByRole('spinbutton', { name: 'PDF 页码' }).press('Enter');
  await expect(page.locator('.pdf-page[data-page="3"]')).toContainText('Offline page 3');
  expect(downloads).toHaveLength(1);
  await context.setOffline(false);
});

test('an incomplete auth response leaves the previously saved offline session intact', async ({
  page,
  context,
}) => {
  test.setTimeout(100_000);
  await login(page);
  const note = await create(page, {
    title: '网络中断保护',
    kind: 'text',
    content: '已经保存的内容不能因为响应中断而丢失。',
  });
  await page.goto(`/n/${note.id}`);
  await pin(page, note.title);
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"authenticated":' }),
  );
  await page.reload();
  await expect(page.locator('.boot-screen .inline-error')).toContainText('服务器响应不完整');
  expect((await cacheRecords(page)).find((item) => item.id === note.id)?.pinned).toBe(true);
  await page.unroute('**/api/auth/status');
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.plain-text')).toHaveText('已经保存的内容不能因为响应中断而丢失。');
  await context.setOffline(false);
});
