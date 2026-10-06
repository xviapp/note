import { test, expect, type Page } from './fixtures';
import { readFile } from 'node:fs/promises';
import { BlobReader, ZipReader } from '@zip.js/zip.js';
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
async function settings(page: Page, section = '分享保存') {
  await expect(page.locator('.app-shell')).toBeVisible();
  const menu = page.getByRole('button', { name: '打开笔记目录', exact: true });
  if (await menu.isVisible()) await menu.click();
  if (await page.locator('.android-shell').count()) {
    const tabs = page.locator('.phone-bottom-nav');
    for (let i = 0; i < 5 && !(await tabs.isVisible()); i++) {
      const previous = page.url();
      await page.getByRole('button', { name: '返回', exact: true }).click();
      await expect(page).not.toHaveURL(previous);
    }
    await expect(tabs).toBeVisible();
    await tabs.getByRole('button', { name: '设置', exact: true }).click();
  } else await page.locator('.main-nav').getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('.settings-entry').getByText(section, { exact: true }).click();
}
function pdfFixture(count = 12) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${count} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (let i = 0; i < count; i++) {
    const stream = `BT /F1 20 Tf 30 450 Td (Touch reading page ${i + 1}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 520] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  }
  let data = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(data));
    data += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(data);
  data += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(data);
}
async function nativeMock(page: Page, shares: unknown[] = []) {
  await page.addInitScript((incoming) => {
    const win = window as any;
    win.androidBridge = {};
    win.__nativeCalls = [];
    win.Capacitor = {
      PluginHeaders: [
        {
          name: 'NoteDevice',
          methods: [
            'getBuildInfo',
            'getPendingShare',
            'discardShare',
            'closeShare',
            'saveFile',
          ].map((name) => ({
            name,
            rtype: 'promise',
          })),
        },
      ],
      nativePromise: async (plugin: string, method: string, options: any) => {
        win.__nativeCalls.push({ plugin, method, options });
        if (method === 'getBuildInfo')
          return { version: '0.2.4', build: 6, certificate: 'b'.repeat(64) };
        if (method === 'getPendingShare') {
          // Reads the inbox first, then may wait, like a slow native call.
          const share = incoming[0] || null;
          await win.__shareGate;
          return { share };
        }
        if (method === 'discardShare') {
          incoming.shift();
          return {};
        }
        if (method === 'saveFile') return { cancelled: false };
        return {};
      },
    };
    win.__shares = incoming;
  }, shares);
}
test('a share that arrives while the inbox is being read still opens', async ({ page }) => {
  await login(page);
  await page.addInitScript(() => {
    const win = window as any;
    win.__shareGate = new Promise((resolve) => (win.__openGate = resolve));
  });
  await nativeMock(page);
  await page.goto('/');
  await expect
    .poll(() => page.evaluate(() => (window as any).__nativeCalls.length))
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    const win = window as any;
    win.__shares.push({ id: crypto.randomUUID(), title: '迟到的分享', text: '正文', files: [] });
    window.dispatchEvent(new Event('note:share'));
    win.__openGate();
  });
  const dialog = page.getByRole('dialog', { name: '保存到页间', exact: true });
  await expect(dialog.getByLabel('标题', { exact: true })).toHaveValue('迟到的分享');
});
test('reader shares preserve Markdown and provenance, preview images and only save after confirmation', async ({
  page,
}, info) => {
  await login(page);
  await page.request.put('/api/share/settings', { headers, data: { parentId: null } });
  const id = crypto.randomUUID(),
    cancelledId = crypto.randomUUID(),
    imageShareId = crypto.randomUUID(),
    imageId = crypto.randomUUID();
  const text =
    'AI 回答\n\n# 阅读方法\n\n**保留完整回答**\n\n——\n书名：阅读之书\n作者：作者甲\n讨论：章节问题';
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
  const filename = '阅读之书-第 12 页-第一节.png';
  await nativeMock(page, [
    { id, title: '章节问题', text, files: [] },
    {
      id: cancelledId,
      title: '阅读之书 · OCR 原文',
      text: 'OCR 原文\n\n——\n书名：阅读之书\n位置：第 12 页',
      files: [],
    },
    {
      id: imageShareId,
      text: '',
      files: [
        {
          id: imageId,
          name: filename,
          mime: 'image/png',
          size: image.length,
          path: `/__share/${imageShareId}/${imageId}`,
        },
      ],
    },
  ]);
  await page.route('**/__share/**', (route) =>
    route.fulfill({ contentType: 'application/octet-stream', body: image }),
  );
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/nodes')) writes++;
  });
  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: '保存到页间', exact: true });
  await expect(dialog.getByLabel('正文', { exact: true })).toHaveValue(text);
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  expect(writes).toBe(0);
  await dialog.getByLabel('标题', { exact: true }).fill('我的读书笔记');
  await page.evaluate(() => window.dispatchEvent(new Event('note:share')));
  await expect(dialog.getByLabel('标题', { exact: true })).toHaveValue('我的读书笔记');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog.getByLabel('标题', { exact: true })).toHaveValue('阅读之书 · OCR 原文');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog.getByLabel('标题', { exact: true })).toHaveValue('阅读之书-第 12 页-第一节');
  const preview = dialog.getByRole('img', { name: filename });
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  expect(writes).toBe(1);
  for (const theme of ['light', 'dark', 'starry']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await page.screenshot({ path: `test-results/reader-share-${info.project.name}-${theme}.png` });
  }
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toBe(2);
  const { nodes } = await (await page.request.get('/api/nodes?parent=')).json();
  expect(nodes).toHaveLength(2);
  const note = nodes.find((node: { title: string }) => node.title === '我的读书笔记');
  const detail = await (await page.request.get(`/api/nodes/${note.id}`)).json();
  expect(detail.content).toBe(text);
  expect(nodes.find((node: { kind: string }) => node.kind === 'image').title).toBe(
    '阅读之书-第 12 页-第一节',
  );
});
test('share destination settings persist and allow a one-time override without submitting the picker', async ({
  page,
}, info) => {
  await login(page);
  const create = async (data: object) =>
    (await page.request.post('/api/nodes', { headers, data })).json();
  const root = await create({
    kind: 'folder',
    title: `分享收件箱 ${info.project.name}`,
    icon: { emoji: '📚' },
  });
  const child = await create({
    kind: 'folder',
    title: '网页收藏',
    parentId: root.id,
    icon: { emoji: '🌿' },
  });
  await page.request.put('/api/share/settings', { headers, data: { parentId: null } });
  await page.goto('/');
  await settings(page);
  await page.getByRole('button', { name: '更改目录', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '分享默认保存目录', exact: true });
  await picker.getByRole('button', { name: `进入 ${root.title}`, exact: true }).click();
  await picker.getByRole('button', { name: child.title, exact: true }).click();
  await expect(picker.locator('.destination-summary')).toContainText(child.title);
  await picker.getByRole('button', { name: '保存', exact: true }).click();
  await expect(picker).toHaveCount(0);
  await page.reload();
  await settings(page);
  await expect(page.locator('.share-settings .destination-summary')).toContainText(
    `${root.title} / ${child.title}`,
  );
  await page.locator('.share-settings').scrollIntoViewIfNeeded();
  await expect(page.locator('.share-settings .destination-summary')).toBeVisible();
  await page.screenshot({ path: `.wrangler/share-settings-${info.project.name}.png` });
  const firstTitle = `默认位置分享 ${info.project.name}`;
  const secondTitle = `临时位置分享 ${info.project.name}`;
  await nativeMock(page, [
    { id: crypto.randomUUID(), title: firstTitle, text: 'https://example.com/paper', files: [] },
    { id: crypto.randomUUID(), title: secondTitle, text: '一段分享文字', files: [] },
  ]);
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/nodes')) writes++;
  });
  await page.reload();
  const share = page.getByRole('dialog', { name: '保存到页间', exact: true });
  await expect(share.locator('.destination-summary')).toContainText(
    `${root.title} / ${child.title}`,
  );
  await share.getByRole('button', { name: '选择当前目录', exact: true }).click();
  expect(writes).toBe(0);
  await expect(share).toBeVisible();
  await share.getByRole('button', { name: '保存', exact: true }).click();
  await expect(share.getByLabel('标题', { exact: true })).toHaveValue(secondTitle);
  expect(
    (await (await page.request.get(`/api/nodes?parent=${child.id}`)).json()).nodes.some(
      (n: any) => n.title === firstTitle,
    ),
  ).toBe(true);
  await expect(share.locator('.destination-summary')).toContainText(child.title);
  await share.getByRole('button', { name: '全部笔记', exact: true }).click();
  await share.getByRole('button', { name: '选择根目录', exact: true }).click();
  expect(writes).toBe(1);
  await expect(share.locator('.destination-summary')).toHaveText('保存到：根目录');
  await share.getByRole('button', { name: '保存', exact: true }).click();
  await expect(share).toHaveCount(0);
  expect(writes).toBe(2);
  expect(
    (await (await page.request.get('/api/nodes')).json()).nodes.some(
      (n: any) => n.title === secondTitle,
    ),
  ).toBe(true);
  expect((await (await page.request.get('/api/share/settings')).json()).parentId).toBe(child.id);
  const { count } = await (await page.request.get(`/api/nodes/${root.id}/delete-preview`)).json();
  await page.request.delete(`/api/nodes/${root.id}`, { headers, data: { count } });
  await settings(page);
  await expect(page.locator('.share-settings .destination-summary')).toHaveText('根目录');
});

test('folder icons can be created, replaced, cancelled and reset across lists and offline reopening', async ({
  page,
  context,
}, info) => {
  await login(page);
  await page.goto('/');
  await expect(page.locator('.app-shell')).toBeVisible();
  await page.getByRole('button', { name: '新建', exact: true }).click();
  const create = page.getByRole('dialog', { name: '新建笔记', exact: true });
  const title = `图标目录 ${info.project.name}`;
  await create.getByRole('radio', { name: '文件夹', exact: true }).check();
  await create.getByLabel('标题', { exact: true }).fill(title);
  await create.getByRole('button', { name: '使用 📚', exact: true }).click();
  await create.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.locator('.document-kind .custom-folder-icon')).toHaveText('📚');
  const nodeId = new URL(page.url()).pathname.split('/').at(-1)!;
  const menu = page.locator('.note-actions .node-menu');
  const openIcons = async () => {
    await menu.getByRole('button', { name: `管理 ${title}`, exact: true }).click();
    await menu.getByRole('button', { name: '更换图标', exact: true }).click();
    return page.getByRole('dialog', { name: '更换文件夹图标', exact: true });
  };
  let icons = await openIcons();
  await icons.getByLabel('自定义 Emoji', { exact: true }).fill('不是 Emoji');
  await expect(icons.getByRole('button', { name: '保存信息' })).toBeDisabled();
  await icons.getByLabel('自定义 Emoji', { exact: true }).fill('👩🏽‍🔬');
  await icons.getByRole('button', { name: '保存信息' }).click();
  await expect(page.locator('.document-kind .custom-folder-icon')).toHaveText('👩🏽‍🔬');
  icons = await openIcons();
  await icons.getByLabel('上传文件夹图标', { exact: true }).setInputFiles({
    name: 'icon.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" rx="40" fill="#12615c"/><path d="M85 80h60l20 20h80v95H85z" fill="#f5ebd1"/></svg>',
    ),
  });
  await expect(icons.locator('.folder-icon-preview > img')).toBeVisible();
  await page.screenshot({ path: `.wrangler/folder-icons-${info.project.name}.png` });
  await icons.getByRole('button', { name: '保存信息' }).click();
  await expect(page.locator('.document-kind .custom-folder-icon img')).toBeVisible();
  const node = await (await page.request.get(`/api/nodes/${nodeId}`)).json();
  expect(node.icon_blob_id).toBeTruthy();
  expect(node.icon_emoji).toBeNull();
  const iconResponse = await page.request.get(`/api/files/${node.icon_blob_id}`);
  expect(iconResponse.headers()['content-type']).toContain('image/webp');
  expect((await iconResponse.body()).length).toBeLessThan(128 * 1024);
  await page.reload();
  await expect(page.locator('.document-kind .custom-folder-icon img')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const db = await new Promise<IDBDatabase>((resolve) => {
          const open = indexedDB.open('yejian-offline', 3);
          open.onsuccess = () => resolve(open.result);
        });
        const cached = await new Promise<any>((resolve) => {
          const request = db.transaction('notes').objectStore('notes').get(id);
          request.onsuccess = () => resolve(request.result);
        });
        db.close();
        return (
          !!cached?.complete &&
          cached.files.some((file: any) => file.id === cached.detail.icon_blob_id)
        );
      }, nodeId),
    )
    .toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.document-kind .custom-folder-icon img')).toBeVisible({
    timeout: 20000,
  });
  expect(
    await page
      .locator('.document-kind .custom-folder-icon img')
      .evaluate((img: HTMLImageElement) => img.naturalWidth),
  ).toBe(192);
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  icons = await openIcons();
  await icons.getByRole('button', { name: '恢复默认', exact: true }).click();
  await icons.getByRole('button', { name: '取消', exact: true }).click();
  expect((await (await page.request.get(`/api/nodes/${nodeId}`)).json()).icon_blob_id).toBe(
    node.icon_blob_id,
  );
  await page.getByRole('button', { name: '收藏笔记', exact: true }).click();
  const nav = page.getByRole('button', { name: '打开笔记目录', exact: true });
  if (await nav.isVisible()) await nav.click();
  const treeImage = page
    .locator('.tree-label')
    .filter({ hasText: title })
    .locator('.custom-folder-icon img');
  await expect(treeImage).toBeVisible();
  await page.locator('.main-nav').getByRole('button', { name: '收藏', exact: true }).click();
  const row = page.locator('.node-list-row').filter({ hasText: title });
  await expect(row.locator('.custom-folder-icon img')).toBeVisible();
  await row.locator('.node-list-main').click();
  icons = await openIcons();
  await icons.getByRole('button', { name: '恢复默认', exact: true }).click();
  await icons.getByRole('button', { name: '保存信息' }).click();
  await expect(page.locator('.document-kind .custom-folder-icon')).toHaveCount(0);
  await expect(page.locator('.document-kind .kind-folder')).toBeVisible();
});
test('untitled notes open for writing and Qingli uses the floating entry', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await page.getByRole('button', { name: '新建', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新建笔记', exact: true });
  await expect(form.getByLabel('标题', { exact: true })).toHaveValue('');
  await form.getByRole('button', { name: '创建', exact: true }).click();
  // The empty note opens in the editor without the edit confirmation.
  await expect(page.getByRole('textbox', { name: 'Markdown 源码' })).toBeFocused();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('heading', { name: '未命名笔记', exact: true })).toBeVisible();
  expect(
    (
      await (
        await page.request.get(new URL(page.url()).pathname.replace('/n/', '/api/nodes/'))
      ).json()
    ).title,
  ).toBe('未命名笔记');
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await expect(
    page.locator('.note-actions').getByRole('button', { name: '青藜', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '打开青藜', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '青藜', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭青藜', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开青藜', exact: true })).toBeVisible();
  const parentId = new URL(page.url()).pathname.split('/').at(-1);
  const menu = page.locator('.note-actions .node-menu');
  await menu.getByRole('button', { name: '管理 未命名笔记', exact: true }).click();
  await menu.getByRole('button', { name: '新建笔记', exact: true }).click();
  await form.getByRole('radio', { name: '纯文本', exact: true }).check();
  await form.getByLabel('标题', { exact: true }).fill('   ');
  await form.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '纯文本正文' })).toBeFocused();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('heading', { name: '未命名文本', exact: true })).toBeVisible();
  const detail = await (
    await page.request.get(new URL(page.url()).pathname.replace('/n/', '/api/nodes/'))
  ).json();
  expect(detail.parent_id).toBe(parentId);
});

test('installed build is shown and update download is signature-aware with a checksum', async ({
  page,
}) => {
  await login(page);
  await nativeMock(page);
  const release = {
    version: '0.3.0',
    build: 7,
    size: 30000,
    sha256: 'a'.repeat(64),
    certificate: 'b'.repeat(64),
    publishedAt: new Date().toISOString(),
    notes: '支持系统分享、PDF 手势和整库备份。',
  };
  await page.route('**/api/app/android-release', (route) => route.fulfill({ json: { release } }));
  await page.goto('/');
  await settings(page, '关于页间');
  await expect(page.getByText('Android 0.2.4', { exact: true })).toBeVisible();
  await expect(page.getByText('构建 6', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '检查 Android 更新' }).click();
  await page.getByRole('button', { name: '下载安装包' }).click();
  await expect(page.getByText('安装包已校验并保存，打开文件即可安装。')).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as any).__nativeCalls.find((call: any) => call.method === 'saveFile').options
          .sha256,
    ),
  ).toBe(release.sha256);
  release.certificate = 'c'.repeat(64);
  await page.getByRole('button', { name: '检查 Android 更新' }).click();
  await expect(page.getByRole('button', { name: '下载安装包' })).toBeDisabled();
});
test('incoming links and PDFs wait for confirmation and import into the library', async ({
  page,
}, info) => {
  await login(page);
  const id = crypto.randomUUID(),
    fileId = crypto.randomUUID();
  const bytes = pdfFixture();
  await nativeMock(page, [
    {
      id,
      title: `分享链接 ${info.project.name}`,
      text: 'https://arxiv.org/abs/2501.00001',
      files: [],
    },
    {
      id: fileId,
      title: `分享 PDF ${info.project.name}`,
      text: '',
      files: [
        {
          id,
          name: 'shared.pdf',
          mime: 'application/pdf',
          size: bytes.length,
          path: `/__share/${fileId}/${id}`,
        },
      ],
    },
  ]);
  await page.route('**/__share/**', (route) =>
    route.fulfill({ contentType: 'application/pdf', body: bytes }),
  );
  let writes = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/api/nodes')) writes++;
  });
  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: '保存到页间', exact: true });
  await expect(dialog).toBeVisible();
  expect(writes).toBe(0);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog.getByLabel('标题', { exact: true })).toHaveValue(
    `分享 PDF ${info.project.name}`,
  );
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'PDF 阅读器' })).toBeVisible();
  expect(writes).toBe(2);
});
test('PDF pinch previews without rerender, keeps an anchor, remembers zoom and double-taps to fit', async ({
  page,
}) => {
  await login(page);
  const data = pdfFixture(80);
  const uploaded = await (
    await page.request.post(`/api/files?name=touch.pdf&size=${data.length}`, { headers, data })
  ).json();
  const node = await (
    await page.request.post('/api/nodes', {
      headers,
      data: { kind: 'pdf', title: '触控长论文', fileId: uploaded.id },
    })
  ).json();
  await page.goto(`/n/${node.id}`);
  await expect(page.locator('.pdf-page canvas').first()).toBeVisible();
  const number = page.getByRole('spinbutton', { name: 'PDF 页码' });
  await number.fill('30');
  await number.press('Enter');
  await expect(page.locator('.pdf-page[data-page="30"]')).toBeVisible();
  await page.evaluate(async () => {
    const area = document.querySelector<HTMLElement>('.pdf-scroll')!;
    const rect = area.getBoundingClientRect();
    const touch = (identifier: number, x: number) =>
      new Touch({ identifier, target: area, clientX: rect.left + x, clientY: rect.top + 200 });
    const send = (type: string, touches: Touch[]) =>
      area.dispatchEvent(
        new TouchEvent(type, {
          touches,
          targetTouches: touches,
          changedTouches: touches,
          bubbles: true,
          cancelable: true,
        }),
      );
    const first = area.querySelector('canvas');
    (window as any).__beforePinch = first;
    send('touchstart', [touch(1, 120), touch(2, 220)]);
    send('touchmove', [touch(1, 80), touch(2, 260)]);
    (window as any).__previewUnchanged =
      first === area.querySelector('canvas') && area.dataset.pinching === 'true';
    send('touchend', []);
  });
  expect(await page.evaluate(() => (window as any).__previewUnchanged)).toBe(true);
  await expect(page.getByRole('button', { name: 'PDF 适应宽度' })).toHaveText('180%');
  await expect(number).toHaveValue('30');
  expect(await page.locator('.pdf-page').count()).toBeLessThan(10);
  await page.reload();
  await expect(page.getByRole('button', { name: 'PDF 适应宽度' })).toHaveText('180%');
  await expect(page.getByRole('button', { name: 'PDF 适应宽度' })).toBeEnabled();
  await page.evaluate(() => {
    const area = document.querySelector<HTMLElement>('.pdf-scroll')!,
      rect = area.getBoundingClientRect();
    window.getSelection()?.removeAllRanges();
    const touch = new Touch({
      identifier: 1,
      target: area,
      clientX: rect.left + 80,
      clientY: rect.top + 160,
    });
    for (let i = 0; i < 2; i++) {
      area.dispatchEvent(
        new TouchEvent('touchstart', { touches: [touch], bubbles: true, cancelable: true }),
      );
      area.dispatchEvent(
        new TouchEvent('touchend', {
          touches: [],
          changedTouches: [touch],
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  });
  await expect(page.getByRole('button', { name: 'PDF 适应宽度' })).toHaveText('100%');
});
test('exports a checked ZIP and restores it alongside existing notes', async ({ page }, info) => {
  test.setTimeout(120000);
  await login(page);
  await page.addInitScript(() => {
    (window as any).showSaveFilePicker = undefined;
  });
  const original = await (
    await page.request.post('/api/nodes', {
      headers,
      data: { kind: 'markdown', title: '备份正文', content: '# 保留这段文字\n\n$x^2$' },
    })
  ).json();
  await page.goto('/');
  await settings(page, '备份与恢复');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出整库备份' }).click();
  const download = await downloadPromise;
  const archivePath = `.wrangler/client-backup-${info.project.name}.zip`;
  await download.saveAs(archivePath);
  await expect(page.getByText('备份已保存。', { exact: true })).toBeVisible();
  const bytes = await readFile(archivePath);
  const zip = new ZipReader(new BlobReader(new Blob([bytes])), {
    useWebWorkers: false,
    checkCrc32: true,
  });
  const entries = await zip.getEntries();
  expect(entries.some((entry) => entry.filename === 'yejian.json')).toBe(true);
  await zip.close();
  await page.getByLabel('选择备份文件', { exact: true }).setInputFiles(archivePath);
  await expect(page.getByRole('button', { name: '恢复到新目录', exact: true })).toBeVisible();
  // A failed replacement must not leave the previous archive ready to restore.
  await page.getByLabel('选择备份文件', { exact: true }).setInputFiles({
    name: 'corrupt.zip',
    mimeType: 'application/zip',
    buffer: bytes.subarray(0, 32),
  });
  await expect(page.getByRole('button', { name: '恢复到新目录', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('选择备份文件', { exact: true })).toBeEnabled();
  await page.getByLabel('选择备份文件', { exact: true }).setInputFiles(archivePath);
  await page.getByRole('button', { name: '恢复到新目录', exact: true }).click();
  await page
    .getByRole('dialog', { name: '恢复这份备份？' })
    .getByRole('button', { name: '恢复到新目录' })
    .click();
  await expect(page.getByText('已恢复，可在全部笔记中打开新的备份目录。')).toBeVisible({
    timeout: 60000,
  });
  expect((await page.request.get(`/api/nodes/${original.id}`)).ok()).toBe(true);
  const roots = await (await page.request.get('/api/nodes')).json();
  expect(roots.nodes.some((node: any) => node.title.startsWith('备份恢复'))).toBe(true);
  await page.getByLabel('选择备份文件', { exact: true }).setInputFiles({
    name: 'corrupt.zip',
    mimeType: 'application/zip',
    buffer: bytes.subarray(0, 32),
  });
  await expect(page.getByRole('button', { name: '恢复到新目录', exact: true })).toHaveCount(0);
});

test('an arXiv paper with many images keeps importing over continuations and resumes after a failed step', async ({
  page,
}, info) => {
  await login(page);
  const title = `多图论文 ${info.project.name}`;
  // The real import needs arxiv.org; the created note stands in for its result.
  const created = await (
    await page.request.post('/api/nodes', {
      headers,
      data: { kind: 'link', title, url: 'https://arxiv.org/html/2503.01800v1' },
    })
  ).json();
  const continuations: string[] = [];
  let failNext = true;
  await page.route('**/api/import/arxiv', (route) =>
    route.fulfill({ status: 202, json: { continuation: 'step-1', done: 42, total: 90 } }),
  );
  await page.route('**/api/import/arxiv/continue', async (route) => {
    const { continuation } = route.request().postDataJSON();
    continuations.push(continuation);
    if (continuation === 'step-1')
      return route.fulfill({ status: 202, json: { continuation: 'step-2', done: 84, total: 90 } });
    if (failNext) {
      failNext = false;
      return route.fulfill({ status: 502, json: { error: 'arXiv 暂时限制了访问，请稍后重试。' } });
    }
    return route.fulfill({ status: 201, json: created });
  });
  await page.goto('/');
  await expect(page.locator('.app-shell')).toBeVisible();
  await page.getByRole('button', { name: '新建', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新建笔记', exact: true });
  await form.getByRole('radio', { name: 'arXiv 论文', exact: true }).check();
  await form
    .getByLabel('arXiv 论文地址', { exact: true })
    .fill('https://arxiv.org/html/2503.01800v1');
  await form.getByRole('button', { name: '导入论文', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('arXiv 暂时限制了访问');
  // Retrying resumes from the last step instead of starting the import over.
  await form.getByRole('button', { name: '导入论文', exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(continuations).toEqual(['step-1', 'step-2', 'step-2']);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
});
