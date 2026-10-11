import { test, expect, type Page } from './fixtures';
import { preparePassword } from '../shared/password';

// Android's share window (share.html), with the native bridge mocked.
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
  await page.request.put('/api/share/settings', { headers, data: { parentId: null } });
}
type File = { name: string; mime: string; body: Buffer };
async function openShare(page: Page, share: { title?: string; text?: string; files?: File[] }) {
  const id = crypto.randomUUID();
  const files = (share.files ?? []).map((file) => {
    const fileId = crypto.randomUUID();
    return { ...file, id: fileId, size: file.body.length, path: `/__share/${id}/${fileId}` };
  });
  await page.route('**/__share/**', (route) => {
    const file = files.find((item) => route.request().url().endsWith(item.path));
    return file ? route.fulfill({ body: file.body }) : route.fulfill({ status: 404 });
  });
  await page.addInitScript(
    (incoming) => {
      const win = window as any;
      win.androidBridge = {};
      win.__closed = [];
      win.Capacitor = {
        PluginHeaders: [
          {
            name: 'NoteDevice',
            methods: ['getPendingShare', 'discardShare', 'closeShare'].map((name) => ({
              name,
              rtype: 'promise',
            })),
          },
        ],
        nativePromise: async (_plugin: string, method: string, options: any) => {
          if (method === 'getPendingShare') return { share: incoming };
          if (method === 'closeShare') win.__closed.push(options);
          return {};
        },
      };
    },
    {
      id,
      title: share.title ?? '',
      text: share.text ?? '',
      files: files.map(({ id, name, mime, size, path }) => ({ id, name, mime, size, path })),
    },
  );
  await page.goto('/share.html');
  return page.getByRole('dialog', { name: '保存到页间', exact: true });
}
const closed = (page: Page) => page.evaluate(() => (window as any).__closed);
async function saved(page: Page, title: string) {
  const { nodes } = await (await page.request.get('/api/nodes?parent=')).json();
  const node = nodes.find((item: { title: string }) => item.title === title);
  expect(node, `note「${title}」`).toBeTruthy();
  return (await (await page.request.get(`/api/nodes/${node.id}`)).json()) as Record<string, any>;
}
const unique = (label: string) => `${label} ${crypto.randomUUID().slice(0, 6)}`;
function pdf(pages: number) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(' ')}] /Count ${pages} >>`,
    ...Array.from(
      { length: pages },
      () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 280] >>',
    ),
  ];
  let data = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const offset = data.length;
    data += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = data.length;
  data += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(data);
}
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);

test('Markdown text previews and can be saved as plain text', async ({ page }, info) => {
  await login(page);
  const title = unique('读书摘录');
  const text = `# ${title}\n\n- 第一条\n- 第二条\n\n**重点**`;
  const dialog = await openShare(page, { text });
  await expect(dialog.getByText('Markdown', { exact: true }).first()).toBeVisible();
  await expect(dialog.getByLabel('标题', { exact: true })).toHaveValue(title);
  await dialog.getByRole('button', { name: '预览', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: title })).toBeVisible();
  await page.screenshot({ path: `test-results/share-markdown-${info.project.name}.png` });
  await dialog.getByRole('button', { name: '纯文本', exact: true }).click();
  await expect(dialog.getByLabel('正文', { exact: true })).toHaveValue(text);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => closed(page)).toEqual([{ saved: true }]);
  const note = await saved(page, title);
  expect(note.kind).toBe('text');
  expect(note.content).toBe(text);
});

test('a shared web page becomes a link titled by its caption', async ({ page }, info) => {
  await login(page);
  const caption = unique('一篇文章');
  const dialog = await openShare(page, { text: `${caption}\nhttps://www.example.com/post?id=1` });
  await expect(dialog.getByText('网页链接', { exact: true })).toBeVisible();
  await expect(dialog.getByText('example.com', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('标题', { exact: true })).toHaveValue(caption);
  await expect(dialog.getByLabel('正文', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: `test-results/share-link-${info.project.name}.png` });
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => closed(page)).toEqual([{ saved: true }]);
  expect((await saved(page, caption)).url).toBe('https://www.example.com/post?id=1');
});

test('an arXiv paper shows its abstract and can be kept as a link', async ({ page }, info) => {
  await login(page);
  const paperTitle = unique('Attention Is All You Need');
  await page.route('**/api/import/arxiv/preview?*', (route) => {
    expect(new URL(route.request().url()).searchParams.get('url')).toBe(
      'https://arxiv.org/abs/1706.03762',
    );
    return route.fulfill({
      json: {
        id: '1706.03762',
        title: paperTitle,
        authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar', 'Jakob Uszkoreit'],
        summary: 'The dominant sequence transduction models are based on recurrent networks.',
      },
    });
  });
  const dialog = await openShare(page, { text: 'https://arxiv.org/pdf/1706.03762' });
  await expect(dialog.getByText('arXiv 论文', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('标题', { exact: true })).toHaveValue(paperTitle);
  await expect(dialog.getByText('Ashish Vaswani、Noam Shazeer、Niki Parmar 等 4 人')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '导入', exact: true })).toBeEnabled();
  await page.screenshot({ path: `test-results/share-arxiv-${info.project.name}.png` });
  await dialog.getByRole('radio', { name: '只存链接' }).click();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => closed(page)).toEqual([{ saved: true }]);
  expect((await saved(page, paperTitle)).url).toBe('https://arxiv.org/abs/1706.03762');
});

test('a PDF shows its first page and page count before upload', async ({ page }, info) => {
  await login(page);
  const name = unique('讲义');
  const dialog = await openShare(page, {
    files: [{ name: `${name}.pdf`, mime: 'application/pdf', body: pdf(3) }],
  });
  await expect(dialog.getByText('PDF', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/^3 页 · /)).toBeVisible();
  await expect(dialog.getByLabel('标题', { exact: true })).toHaveValue(name);
  await page.screenshot({ path: `test-results/share-pdf-${info.project.name}.png` });
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => closed(page)).toEqual([{ saved: true }]);
  expect((await saved(page, name)).kind).toBe('pdf');
});

test('several images show as a grid and save as one note each', async ({ page }, info) => {
  await login(page);
  const [first, second] = [unique('书页一'), unique('书页二')];
  const dialog = await openShare(page, {
    files: [
      { name: `${first}.png`, mime: 'image/png', body: png },
      { name: `${second}.png`, mime: 'image/png', body: png },
    ],
  });
  await expect(dialog.getByText('图片', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('img')).toHaveCount(2);
  await expect(dialog.getByText('将保存为 2 条图片笔记，各用文件名作标题。')).toBeVisible();
  await page.screenshot({ path: `test-results/share-images-${info.project.name}.png` });
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => closed(page)).toEqual([{ saved: true }]);
  expect((await saved(page, `${first}.png`)).kind).toBe('image');
  expect((await saved(page, `${second}.png`)).kind).toBe('image');
});

test('a shared .md file is read into the body instead of uploaded', async ({ page }) => {
  await login(page);
  const name = unique('导出笔记');
  const body = '## 小节\n\n- 要点';
  const dialog = await openShare(page, {
    files: [{ name: `${name}.md`, mime: 'text/plain', body: Buffer.from(body) }],
  });
  await expect(dialog.getByText('Markdown', { exact: true }).first()).toBeVisible();
  await expect(dialog.getByLabel('正文', { exact: true })).toHaveValue(body);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => closed(page)).toEqual([{ saved: true }]);
  const note = await saved(page, name);
  expect(note.kind).toBe('markdown');
  expect(note.content).toBe(body);
});

test('cancelling saves nothing, and a signed-out window hands over to the app', async ({
  page,
}) => {
  await login(page);
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/')) writes++;
  });
  const dialog = await openShare(page, { text: '一句话' });
  await expect(dialog.getByText('纯文本', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '取消保存' }).click({ position: { x: 10, y: 10 } });
  await expect.poll(() => closed(page)).toEqual([{}]);
  expect(writes).toBe(0);
  await page.context().clearCookies();
  await page.reload();
  await expect(page.getByText('登录页间后才能保存，分享内容会在页间里等你。')).toBeVisible();
  await page.getByRole('button', { name: '打开页间登录' }).click();
  await expect.poll(() => closed(page)).toEqual([{ openApp: true }]);
});

test('a failed destination lookup blocks saving until retry restores the configured folder', async ({ page }) => {
  await login(page);
  const response = await page.request.post('/api/nodes', {
    headers,
    data: { kind: 'folder', title: unique('分享目录'), parentId: null },
  });
  expect(response.ok()).toBeTruthy();
  const folder = await response.json();
  await page.request.put('/api/share/settings', { headers, data: { parentId: folder.id } });
  let lookups = 0;
  await page.route('**/api/share/settings', (route) => {
    lookups++;
    return lookups === 1
      ? route.fulfill({ status: 503, json: { error: '暂时无法读取保存目录' } })
      : route.continue();
  });
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/nodes') writes++;
  });
  const title = unique('等待目录');
  const dialog = await openShare(page, { text: title });
  await expect(dialog.getByRole('alert')).toHaveText('暂时无法读取保存目录');
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  expect(writes).toBe(0);
  expect(lookups).toBe(1);
  await dialog.getByRole('button', { name: '重新加载保存目录' }).click();
  await expect(dialog.getByText(folder.title, { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => closed(page)).toEqual([{ saved: true }]);
  const { nodes } = await (await page.request.get(`/api/nodes?parent=${folder.id}`)).json();
  expect(nodes).toEqual(expect.arrayContaining([expect.objectContaining({ title, parent_id: folder.id })]));
  expect(writes).toBe(1);
});
