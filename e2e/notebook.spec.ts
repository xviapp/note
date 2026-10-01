import { expect, test, type Page, type Locator } from '@playwright/test';
import { preparePassword } from '../shared/password';
import type { ChatHistory, ChatMessage, ChatInput } from '../shared/assistant';
import { paperHtml, paperPng } from '../tests/fixtures/arxiv';
import { hostileSvg } from '../tests/fixtures/svg';

const password = 'Note2026';
const token = 'e2e-test-only-setup-token-never-deploy-0001';
async function expectPreview(page: Page) {
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.locator('.cm-editor, .edit-toolbar')).toHaveCount(0);
}
async function login(page: Page) {
  const status = await (await page.request.get('/api/auth/status')).json();
  await page.goto(status.initialized ? '/' : `/#setup=${token}`);
  if (!status.initialized) {
    await expect(page.getByLabel('设置密码', { exact: true })).toHaveAttribute(
      'minlength',
      '8',
    );
    await page.getByLabel('设置密码', { exact: true }).fill(password);
    await page.getByLabel('确认密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '创建笔记库' }).click();
  } else {
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '打开笔记库' }).click();
  }
  await expectPreview(page);
}
async function createNote(page: Page, title: string) {
  await page.getByRole('button', { name: '新建', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新建节点' });
  await form.getByLabel('标题', { exact: true }).fill(title);
  await form.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
}
async function edit(page: Page) {
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await page
    .getByRole('dialog', { name: '编辑这篇笔记？' })
    .getByRole('button', { name: '开始编辑' })
    .click();
  await expect(page.getByRole('textbox', { name: 'Markdown 源码' })).toBeVisible();
}
async function selectTheme(page: Page, value: string) {
  const theme = page.getByRole('combobox', { name: '主题', exact: true });
  const openDrawer = !(await theme.isVisible());
  if (openDrawer) await page.getByRole('button', { name: '打开笔记目录', exact: true }).click();
  await theme.selectOption(value);
  if (openDrawer) await page.getByRole('button', { name: '关闭侧栏', exact: true }).click();
}
async function nav(page: Page, name: string) {
  const drawer = page.getByRole('button', { name: '打开笔记目录' });
  if (await drawer.isVisible()) await drawer.click();
  await page.locator('.main-nav').getByRole('button', { name, exact: true }).click();
}

test('default preview, per-file edit confirmation, save/history, favorites, trash and restore', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  await createNote(page, `阅读手记 · ${info.project.name}`);
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await page
    .getByRole('dialog', { name: '编辑这篇笔记？' })
    .getByRole('button', { name: '取消', exact: true })
    .click();
  await expectPreview(page);
  await edit(page);
  const content =
    '# 一个安静的阅读空间\n\n把想法留在页间，让资料有迹可循。\n\n## 本周的阅读\n\n- [x] 整理手边的资料\n- [ ] 留一点时间给思考\n\n> 阅读，是与自己的一次长谈。\n\n## 一些值得记住的事\n\n| 内容 | 状态 |\n| --- | --- |\n| 随手笔记 | 已整理 |\n| 收藏资料 | 继续读 |\n\n```js\nconst nextPage = () => keepReading();\n```\n\n## 下一页\n\n按自己的节奏，慢慢读。\n';
  await page.getByRole('textbox', { name: 'Markdown 源码' }).fill(content);
  if (info.project.name === 'mobile') {
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await expect(
      page.locator('.read-content').getByRole('heading', { name: '一个安静的阅读空间' }),
    ).toBeVisible();
    await page.getByRole('button', { name: '源码', exact: true }).click();
  }
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await expect(
    page.locator('.read-content').getByRole('heading', { name: '本周的阅读' }),
  ).toBeVisible();
  await expect(page.locator('.read-content input[type=checkbox]').first()).toBeDisabled();
  await page.getByRole('button', { name: '收藏笔记', exact: true }).click();
  const url = page.url();
  await page.reload();
  await expectPreview(page);
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '取消收藏', exact: true })).toBeVisible();
  if (info.project.name === 'mobile') {
    await page.getByRole('button', { name: '标题目录', exact: true }).click();
    await page
      .getByRole('dialog', { name: '标题目录', exact: true })
      .getByRole('button', { name: '一些值得记住的事', exact: true })
      .click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await page.screenshot({
    path: `test-results/reading-${info.project.name}.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await edit(page);
  await page.getByRole('textbox', { name: 'Markdown 源码' }).fill(`${content}\n修改后的内容。`);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '版本历史', exact: true }).click();
  const history = page.getByRole('dialog', { name: '版本历史', exact: true });
  await history.getByRole('button', { name: /版本 2/ }).click();
  await history.getByRole('button', { name: '恢复此版本', exact: true }).click();
  await page
    .getByRole('dialog', { name: '恢复这个版本？' })
    .getByRole('button', { name: '确认并恢复' })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.read-content')).not.toContainText('修改后的内容。');
  await nav(page, '收藏');
  await expect(
    page.locator('.node-list').getByText(`阅读手记 · ${info.project.name}`, { exact: true }),
  ).toBeVisible();
  await page.goto(url);
  await page
    .locator('.note-actions')
    .getByRole('button', { name: `管理 阅读手记 · ${info.project.name}` })
    .click();
  await page
    .locator('.note-actions')
    .getByRole('button', { name: '移到回收站', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: '移到回收站？' })
    .getByRole('button', { name: '移到回收站', exact: true })
    .click();
  await nav(page, '回收站');
  await page
    .locator('.trash-row')
    .filter({ hasText: `阅读手记 · ${info.project.name}` })
    .getByRole('button', { name: '恢复', exact: true })
    .click();
  await expect(
    page.locator('.trash-row').filter({ hasText: `阅读手记 · ${info.project.name}` }),
  ).toHaveCount(0);
  await nav(page, '收藏');
  await page
    .locator('.node-list')
    .getByText(`阅读手记 · ${info.project.name}`, { exact: true })
    .click();
  await expect(
    page.locator('.read-content').getByRole('heading', { name: '本周的阅读' }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('drafts survive canceled navigation and expired file confirmation; new tabs open in preview', async ({
  page,
  context,
}, info) => {
  await login(page);
  await createNote(page, `草稿保护 · ${info.project.name}`);
  await edit(page);
  await page.getByRole('textbox', { name: 'Markdown 源码' }).fill('这是一份尚未保存的草稿。');
  await nav(page, '收藏');
  await page
    .getByRole('dialog', { name: '还有未保存的修改' })
    .getByRole('button', { name: '继续编辑', exact: true })
    .click();
  if (
    info.project.name === 'mobile' &&
    (await page.getByRole('button', { name: '关闭侧栏' }).isVisible())
  )
    await page.getByRole('button', { name: '关闭侧栏' }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown 源码' })).toContainText(
    '尚未保存的草稿',
  );
  const other = await context.newPage();
  await other.goto(page.url());
  await expectPreview(other);
  await expect(other.locator('.cm-editor')).toHaveCount(0);
  await other.close();
  let expired = true;
  await page.route('**/api/nodes/*/content', async (route) => {
    if (expired && route.request().method() === 'PUT') {
      expired = false;
      await route.fulfill({
        status: 403,
        json: {
          error: '编辑确认已失效，请重新确认；当前编辑内容会保留。',
          code: 'EDIT_LOCKED',
        },
      });
    } else await route.fallback();
  });
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('编辑确认已失效');
  await expect(page.getByRole('textbox', { name: 'Markdown 源码' })).toContainText(
    '尚未保存的草稿',
  );
  await page.getByRole('button', { name: '重新确认编辑', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('编辑确认已更新');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await expect(page.locator('.read-content')).toContainText('尚未保存的草稿');
});

test('creation, rename, moving and storage settings work without unlocking file editing', async ({
  page,
}, info) => {
  await login(page);
  const unlocks: unknown[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/edit/unlock')
      unlocks.push(request.postDataJSON());
  });
  const title = `自由整理 · ${info.project.name}`;
  await createNote(page, title);
  const id = page.url().split('/').at(-1)!;
  const { node: destination } = await assistantSeed(page, {
    kind: 'folder',
    title: `整理目录 · ${info.project.name}`,
  });
  const actions = page.locator('.note-actions');
  await actions.getByRole('button', { name: `管理 ${title}`, exact: true }).click();
  await actions.getByRole('button', { name: '重命名', exact: true }).click();
  const rename = page.getByRole('dialog', { name: '修改节点信息', exact: true });
  await rename.getByLabel('标题', { exact: true }).fill(`${title}已改名`);
  await rename.getByRole('button', { name: '保存信息', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: `${title}已改名`, exact: true }),
  ).toBeVisible();
  await actions.getByRole('button', { name: `管理 ${title}已改名`, exact: true }).click();
  await actions.getByRole('button', { name: '移动到…', exact: true }).click();
  const move = page.getByRole('dialog', { name: `移动「${title}已改名」`, exact: true });
  await move.getByRole('button', { name: destination.title, exact: true }).click();
  await move.getByRole('button', { name: '确认移动', exact: true }).click();
  await expect(move).toHaveCount(0);
  await expect
    .poll(async () => (await (await page.request.get(`/api/nodes/${id}`)).json()).parent_id)
    .toBe(destination.id);
  if (info.project.name === 'desktop') {
    await page
      .locator('.sidebar-tree')
      .getByRole('button', { name: `展开 ${destination.title}`, exact: true })
      .click();
    const row = page
      .locator('.tree-row')
      .filter({ has: page.getByRole('button', { name: `${title}已改名`, exact: true }) });
    await expect(row).toHaveAttribute('draggable', 'true');
    await row.dragTo(page.locator('.tree > .section-label'));
    await expect
      .poll(async () => (await (await page.request.get(`/api/nodes/${id}`)).json()).parent_id)
      .toBeNull();
  }
  await expectPreview(page);
  const note = await (await page.request.get(`/api/nodes/${id}`)).json();
  const blocked = await page.request.put(`/api/nodes/${id}/content`, {
    headers: { origin: 'http://127.0.0.1:8799' },
    data: { revision: note.revision, content: '意外写入', attachments: [] },
  });
  expect(blocked.status()).toBe(403);
  expect((await (await page.request.get(`/api/nodes/${id}`)).json()).content).toBe('');
  const storage = await (await page.request.get('/api/storage')).json();
  await nav(page, '设置');
  await page
    .getByLabel('容量上限 GB', { exact: true })
    .fill(String(storage.quotaBytes / 1e9 + 1));
  await page.getByRole('button', { name: '更新上限', exact: true }).click();
  await expect
    .poll(async () => (await (await page.request.get('/api/storage')).json()).quotaBytes)
    .toBe(storage.quotaBytes + 1e9);
  await page.getByLabel('容量上限 GB', { exact: true }).fill(String(storage.quotaBytes / 1e9));
  await page.getByRole('button', { name: '更新上限', exact: true }).click();
  await expect
    .poll(async () => (await (await page.request.get('/api/storage')).json()).quotaBytes)
    .toBe(storage.quotaBytes);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(unlocks).toEqual([]);
});

function pdfFixture(count = 2, mixedSizes = false, imageOnly = false) {
  const pages = Array.from({ length: count }, (_, index) => {
    const landscape = mixedSizes && index % 4 === 1;
    return { number: index + 1, width: landscape ? 640 : 450, height: landscape ? 450 : 640 };
  });
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${count} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...pages.flatMap(({ number, width, height }, index) => {
      const stream = [
        `0.19 0.36 0.58 rg BT /F1 10 Tf 40 ${height - 42} Td (READING NOTES / ${String(number).padStart(2, '0')}) Tj ET`,
        `0.14 0.20 0.29 rg BT /F1 25 Tf 40 ${height - 94} Td (A quiet page - ${number}) Tj ET`,
        `0.86 0.89 0.93 RG 40 ${height - 114} m ${width - 40} ${height - 114} l S`,
        ...Array.from(
          { length: 3 },
          (_, section) =>
            `BT /F1 12 Tf 40 ${height - 151 - section * 65} Td 19 TL (Read at your own pace.) Tj T* (One page flows naturally into the next.) Tj ET`,
        ),
        `0.45 0.52 0.61 rg BT /F1 10 Tf 40 32 Td (PAGE ${number} / ${count}) Tj ET`,
      ]
        .filter((line) => !imageOnly || !line.includes('BT'))
        .join('\n');
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
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
    .join(
      '',
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(data);
}

test('PDF and image attachments, shared file nodes and PDF reading progress', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);
  await createNote(page, `附件资料 · ${info.project.name}`);
  await edit(page);
  await page
    .getByRole('textbox', { name: 'Markdown 源码' })
    .fill('# 附件资料\n\n点开附件即可阅读。');
  await page
    .getByLabel('上传附件', { exact: true })
    .setInputFiles({ name: 'reading.pdf', mimeType: 'application/pdf', buffer: pdfFixture() });
  await expect(page.getByText('上传中…')).toHaveCount(0);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('.attachment-name').filter({ hasText: 'reading.pdf' }).click();
  const pdfDialog = page.getByRole('dialog', { name: 'reading.pdf' });
  await expect(pdfDialog.locator('canvas').first()).toBeVisible();
  await expect(pdfDialog.locator('.pdf-page').first()).toHaveAttribute('aria-busy', 'false');
  await pdfDialog.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(pdfDialog.getByRole('spinbutton', { name: 'PDF 页码' })).toHaveValue('2');
  await page.screenshot({ path: `test-results/pdf-${info.project.name}.png` });
  await pdfDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '将 reading.pdf 添加到笔记树' }).click();
  await page
    .getByRole('dialog', { name: '将附件添加到笔记树' })
    .getByRole('button', { name: '创建', exact: true })
    .click();
  await expect(page.getByRole('region', { name: 'PDF 阅读器' })).toBeVisible();
  await expect(page.locator('.pdf-page[data-page="1"]')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.note-scroll, .document-heading')).toHaveCount(0);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  const pdfUrl = page.url(),
    readingPath = `/api/nodes/${pdfUrl.split('/').at(-1)}/reading`;
  await nav(page, '最近访问');
  await expect
    .poll(async () => (await (await page.request.get(readingPath)).json()).position.page)
    .toBe(2);
  await page.goto(pdfUrl);
  await expect(page.getByRole('spinbutton', { name: 'PDF 页码' })).toHaveValue('2');
  // The image is a valid tiny PNG fixture; the production UI must render it,
  // open the viewer and preserve a separate immutable attachment reference.
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=',
    'base64',
  );
  await nav(page, '全部笔记');
  await createNote(page, `图片资料 · ${info.project.name}`);
  await edit(page);
  await page
    .getByLabel('上传附件', { exact: true })
    .setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: image });
  await expect(page.getByText('上传中…')).toHaveCount(0);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('.attachment-name').filter({ hasText: 'pixel.png' }).click();
  const viewer = page.getByRole('dialog', { name: 'pixel.png' });
  await expect(viewer.locator('img')).toBeVisible();
  await viewer.getByRole('button', { name: '放大图片' }).click();
  await expect(viewer.getByText('125%', { exact: true })).toBeVisible();
  await viewer.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('continuous PDF fills the reading pane, renders nearby pages and preserves its anchor', async ({
  page,
  context,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  const origin = new URL(page.url()).origin;
  const headers = { origin };
  const buffer = pdfFixture(40, true);
  const uploaded = await page.request.post(
    `/api/files?name=continuous.pdf&size=${buffer.length}`,
    {
      headers: { ...headers, 'content-type': 'application/pdf' },
      data: buffer,
    },
  );
  expect(uploaded.ok()).toBe(true);
  const created = await page.request.post('/api/nodes', {
    headers: { ...headers, 'x-idempotency-key': crypto.randomUUID() },
    data: { title: '连续阅读', kind: 'pdf', fileId: (await uploaded.json()).id },
  });
  expect(created.ok()).toBe(true);
  const id = (await created.json()).id;
  const url = `/n/${id}`;
  await page.goto(url);
  const viewer = page.getByRole('region', { name: 'PDF 阅读器' });
  const area = page.getByLabel('PDF 阅读区', { exact: true });
  const pageNumber = viewer.getByRole('spinbutton', { name: 'PDF 页码' });
  const sheet = (number: number) => viewer.locator(`.pdf-page[data-page="${number}"]`);
  await expect(sheet(1)).toHaveAttribute('aria-busy', 'false');
  await expectPreview(page);
  await expect(page.locator('.note-scroll, .document-heading, iframe, .cm-editor')).toHaveCount(
    0,
  );
  const workspace = (await page.locator('.note-workspace').boundingBox())!;
  const reader = (await viewer.boundingBox())!;
  expect(reader.width).toBeCloseTo(workspace.width, 0);
  expect(reader.height).toBeCloseTo(workspace.height, 0);
  const toolbarTop = (await viewer.locator('.pdf-toolbar').boundingBox())!.y;

  // Scroll across a page boundary without invoking any page navigation control.
  const firstHeight = (await sheet(1).boundingBox())!.height;
  const areaHeight = (await area.boundingBox())!.height;
  await area.hover();
  await page.mouse.wheel(0, firstHeight - areaHeight / 2);
  await expect(sheet(1)).toBeInViewport();
  await expect(sheet(2)).toBeInViewport();
  await expect(sheet(2)).toHaveAttribute('aria-busy', 'false');
  await page.screenshot({ path: `test-results/pdf-continuous-${info.project.name}.png` });
  await page.mouse.wheel(0, areaHeight / 2 + 70);
  await expect(pageNumber).toHaveValue('2');
  expect((await viewer.locator('.pdf-toolbar').boundingBox())!.y).toBe(toolbarTop);
  expect(await viewer.locator('canvas').count()).toBeLessThan(12);

  // Jump beyond the rendered pages, including a landscape sheet, then record
  // a position partway through a portrait page.
  await pageNumber.fill('30');
  await pageNumber.press('Enter');
  await expect(sheet(30)).toHaveAttribute('aria-busy', 'false');
  const landscape = (await sheet(30).boundingBox())!;
  expect(landscape.width).toBeGreaterThan(landscape.height);
  await viewer.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(pageNumber).toHaveValue('31');
  await expect(sheet(31)).toHaveAttribute('aria-busy', 'false');
  await area.hover();
  await page.mouse.wheel(0, (await sheet(31).boundingBox())!.height * 0.35);
  const stored = () =>
    page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) || '{}').position,
      `reading:${id}`,
    );
  await expect.poll(async () => (await stored())?.pageRatio || 0).toBeGreaterThan(0.3);
  const offset = async (target: Page) =>
    target.locator('.pdf-scroll').evaluate((element) => {
      const sheet = element.querySelector('.pdf-page[data-page="31"]')!;
      return (
        (element.getBoundingClientRect().top - sheet.getBoundingClientRect().top) /
        sheet.getBoundingClientRect().height
      );
    });
  const beforeZoom = await offset(page);
  await selectTheme(page, 'dark');
  await expect(pageNumber).toHaveValue('31');
  await expect.poll(async () => Math.abs((await offset(page)) - beforeZoom)).toBeLessThan(0.04);
  await viewer.getByRole('button', { name: '放大 PDF', exact: true }).click();
  await expect(viewer.getByRole('button', { name: 'PDF 适应宽度' })).toHaveText('120%');
  await expect.poll(async () => Math.abs((await offset(page)) - beforeZoom)).toBeLessThan(0.04);
  await expect(pageNumber).toHaveValue('31');
  const originalViewport = page.viewportSize()!;
  await page.setViewportSize(
    info.project.name === 'mobile' ? { width: 844, height: 390 } : { width: 1000, height: 760 },
  );
  await expect.poll(async () => Math.abs((await offset(page)) - beforeZoom)).toBeLessThan(0.04);
  await expect(pageNumber).toHaveValue('31');
  await page.setViewportSize(originalViewport);
  await viewer.getByRole('button', { name: 'PDF 适应宽度' }).click();
  await expect(viewer.getByRole('button', { name: 'PDF 适应宽度' })).toHaveText('100%');
  await expect.poll(async () => Math.abs((await offset(page)) - beforeZoom)).toBeLessThan(0.04);
  expect(await viewer.locator('canvas').count()).toBeLessThan(12);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);

  await nav(page, '最近访问');
  const reading = () =>
    page.request.get(`/api/nodes/${id}/reading`).then((response) => response.json());
  await expect.poll(async () => (await reading()).position.page).toBe(31);
  await expect.poll(async () => (await reading()).position.pageRatio).toBeGreaterThan(0.3);
  const other = await context.newPage();
  other.on('pageerror', (error) => errors.push(error.message));
  await other.goto(url);
  await expect(other.getByRole('spinbutton', { name: 'PDF 页码' })).toHaveValue('31');
  await expect(other.locator('.pdf-page[data-page="31"]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect
    .poll(async () => Math.abs((await offset(other)) - beforeZoom))
    .toBeLessThan(0.04);
  await other.getByRole('spinbutton', { name: 'PDF 页码' }).fill('999');
  await other.getByRole('spinbutton', { name: 'PDF 页码' }).press('Enter');
  await expect(other.getByRole('spinbutton', { name: 'PDF 页码' })).toHaveValue('40');
  await expect(other.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
  await other.close();
  expect(errors).toEqual([]);
});

test('reading positions resume across devices and a conflicting save preserves the draft', async ({
  page,
  context,
}, info) => {
  await login(page);
  await createNote(page, `接续阅读 · ${info.project.name}`);
  await edit(page);
  const longNote = Array.from(
    { length: 20 },
    (_, i) => `## 第 ${i + 1} 节\n\n${'这一页留给慢慢阅读的自己。'.repeat(30)}\n`,
  ).join('\n');
  await page.getByRole('textbox', { name: 'Markdown 源码' }).fill(longNote);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  const url = page.url(),
    id = url.split('/').at(-1);
  if (info.project.name === 'mobile') {
    await page.getByRole('button', { name: '标题目录', exact: true }).click();
    await page
      .getByRole('dialog', { name: '标题目录', exact: true })
      .getByRole('button', { name: '第 20 节', exact: true })
      .click();
  } else {
    await page.locator('.note-scroll').focus();
    await page.keyboard.press('End');
  }
  await expect
    .poll(async () =>
      page
        .locator('.note-scroll')
        .evaluate(
          (element) =>
            element.scrollTop / Math.max(1, element.scrollHeight - element.clientHeight),
        ),
    )
    // End and the mobile heading jump animate; leave only after reaching the
    // requested end position, so this verifies saving that position.
    .toBeGreaterThan(0.95);
  const headings = await page
    .locator('.read-content h2')
    .evaluateAll((elements) => elements.map((element) => element.id));
  expect(new Set(headings).size).toBe(20);
  await nav(page, '收藏');
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/nodes/${id}/reading`)).json()).position.ratio || 0,
    )
    .toBeGreaterThan(0.7);
  const other = await context.newPage();
  await other.goto(url);
  await expect(other.locator('.read-content h2')).toHaveCount(20);
  await expect
    .poll(async () => other.locator('.note-scroll').evaluate((element) => element.scrollTop))
    .toBeGreaterThan(500);
  await page.goto(url);
  await edit(page);
  await edit(other);
  await page.getByRole('textbox', { name: 'Markdown 源码' }).fill('设备一保存的正文');
  await other.getByRole('textbox', { name: 'Markdown 源码' }).fill('设备二仍然保留的草稿');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await other.getByRole('button', { name: '保存', exact: true }).click();
  await expect(other.getByRole('alert')).toContainText('已在其他页面更新');
  await expect(other.getByRole('textbox', { name: 'Markdown 源码' })).toContainText(
    '设备二仍然保留的草稿',
  );
  await other.close();
});

test('themes persist, follow the system and preserve the current note and unsaved editor', async ({
  page,
  context,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: 'dark' });
  await login(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await createNote(page, `项目笔记 · ${info.project.name}`);
  await edit(page);
  const content =
    '# 阅读器更新\n\n## 本周任务\n\n- [x] 连续阅读 PDF\n- [x] 主题切换\n- [ ] 整理项目资料\n\n## 实施记录\n\n> 主题选择保存在当前设备，刷新后继续使用。\n\n| 项目 | 状态 |\n| --- | --- |\n| 手机布局 | 已完成 |\n| 阅读位置 | 已完成 |\n\n```js\nconst mode = "dark";\n```\n\n[项目文档](https://example.com)';
  await page.getByRole('textbox', { name: 'Markdown 源码' }).fill(content);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const url = page.url();
  const theme = page.getByRole('combobox', { name: '主题', exact: true, includeHidden: true });
  for (const palette of ['light', 'dark', 'starry']) {
    await selectTheme(page, palette);
    await expect(page.locator('html')).toHaveAttribute('data-theme', palette);
    await expect(page.locator('.markdown-body')).toContainText('阅读器更新');
    await expect(page.locator('.cm-editor')).toHaveCount(0);
    expect(page.url()).toBe(url);
    // Check actual rendered text against the reading surface, including small metadata.
    const contrast = await page.locator('.document-meta').evaluate((element) => {
      const luminance = (color: string) => {
        const channels = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((value) => {
            const c = value / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      const foreground = luminance(getComputedStyle(element).color);
      const background = luminance(getComputedStyle(document.documentElement).backgroundColor);
      return (
        (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
      );
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: `test-results/theme-${palette}-${info.project.name}.png` });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await page.reload();
  await expect(theme).toHaveValue('starry');
  await expectPreview(page);
  await edit(page);
  const source = page.getByRole('textbox', { name: 'Markdown 源码' });
  await source.fill(`${content}\n\n未保存的主题测试草稿`);
  await selectTheme(page, 'dark');
  await expect(page.locator('.source-pane .cm-theme-dark')).toBeVisible();
  await selectTheme(page, 'light');
  await expect(page.locator('.source-pane .cm-theme-light')).toBeVisible();
  await expect(source).toContainText('未保存的主题测试草稿');
  await selectTheme(page, 'starry');
  await expect(source).toContainText('未保存的主题测试草稿');
  await page.screenshot({ path: `test-results/theme-editor-${info.project.name}.png` });
  await page.getByRole('button', { name: '保存', exact: true }).click();

  const other = await context.newPage();
  // The small bootstrap must apply the saved palette even before React is available.
  await other.route('**/assets/index-*.js', (route) => route.abort());
  await other.goto('/');
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'starry');
  await other.unroute('**/assets/index-*.js');
  await other.emulateMedia({ colorScheme: 'light' });
  await other.goto(url);
  await expect(
    other.getByRole('combobox', { name: '主题', exact: true, includeHidden: true }),
  ).toHaveValue('starry');
  await selectTheme(page, 'system');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await selectTheme(page, 'dark');
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark');
  await other.close();

  await nav(page, '设置');
  await page.getByRole('radio', { name: '星空', exact: true }).check();
  await expect(theme).toHaveValue('starry');
  await page.screenshot({ path: `test-results/theme-settings-${info.project.name}.png` });
  await page.getByRole('button', { name: '退出当前设备', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开笔记库', exact: true })).toBeVisible();
  await expect(theme).toHaveValue('starry');
  await page.getByRole('button', { name: '忘记密码？', exact: true }).click();
  await expect(page.locator('.auth-form')).toContainText('在部署端重置密码');
  await page.screenshot({ path: `test-results/theme-login-${info.project.name}.png` });
  expect(errors).toEqual([]);
});

test('settings change password and revoke every open device', async ({ page, context }) => {
  await login(page);
  await nav(page, '设置');
  await page.getByRole('button', { name: '修改密码', exact: true }).click();
  const form = page.getByRole('dialog', { name: '修改密码', exact: true }),
    temporary = 'Next2026';
  await expect(form.getByLabel('新密码', { exact: true })).toHaveAttribute('minlength', '8');
  await form.getByLabel('当前密码', { exact: true }).fill(password);
  await form.getByLabel('新密码', { exact: true }).fill(temporary);
  await form.getByLabel('再次输入新密码', { exact: true }).fill(temporary);
  await form.getByRole('button', { name: '修改并重新登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开笔记库', exact: true })).toBeVisible();
  await page.getByLabel('密码', { exact: true }).fill(temporary);
  await page.getByRole('button', { name: '打开笔记库', exact: true }).click();
  await expectPreview(page);
  // Restore the shared test account's password before exercising logout-all.
  const status = await (await page.request.get('/api/auth/status')).json();
  const response = await page.request.post('/api/auth/password', {
    headers: { origin: 'http://127.0.0.1:8799' },
    data: {
      currentPassword: await preparePassword(temporary, status.password),
      newPassword: await preparePassword(password),
    },
  });
  expect(response.ok()).toBe(true);
  await login(page);
  const other = await context.newPage();
  await other.goto('/');
  await expectPreview(other);
  await nav(page, '设置');
  await page.getByRole('button', { name: '退出所有设备', exact: true }).click();
  await page
    .getByRole('dialog', { name: '退出所有设备？' })
    .getByRole('button', { name: '退出所有设备', exact: true })
    .click();
  await expect(page.getByRole('button', { name: '打开笔记库', exact: true })).toBeVisible();
  await other.reload();
  await expect(other.getByRole('button', { name: '打开笔记库', exact: true })).toBeVisible();
  await other.close();
});

// UI fixtures simulate conversation transport; Worker tests exercise the actual
// encrypted settings, provider stream, persistence and export endpoints in D1/R2.
async function assistantFixture(page: Page, options: { interruptFirst?: boolean } = {}) {
  const threads = new Map<string, ChatHistory>();
  const sent: ChatInput[] = [];
  let sequence = 0;
  await page.route('**/api/nodes/*/assistant**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const match = path.match(/\/nodes\/([^/]+)\/assistant(?:\/([^/]+)\/export)?$/);
    if (!match) {
      await route.fallback();
      return;
    }
    const id = match[1];
    const thread = threads.get(id) || { messages: [], nextBefore: null, busy: false };
    threads.set(id, thread);
    if (request.method() === 'GET') {
      await route.fulfill({ json: thread });
      return;
    }
    if (request.method() === 'DELETE') {
      thread.messages = [];
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (match[2]) {
      const message = thread.messages.find((m) => m.id === match[2])!;
      const response = await page.request.post('/api/nodes', {
        headers: {
          origin: 'http://127.0.0.1:8799',
          'x-idempotency-key': `ai-${message.id}`,
        },
        data: { parentId: id, kind: 'markdown', title: '结构要点', content: message.content },
      });
      const node = await response.json();
      message.exportedNodeId = node.id;
      await route.fulfill({ status: response.status(), json: node });
      return;
    }
    const data = request.postDataJSON() as ChatInput;
    sent.push(data);
    const user: ChatMessage = {
      id: crypto.randomUUID(),
      sequence: ++sequence,
      role: 'user',
      status: 'completed',
      content: data.content,
      quote: data.quote,
      createdAt: Date.now(),
    };
    if (data.files)
      user.files = data.files.map((file) => ({
        name: file.name,
        kind: file.kind,
        text: file.text,
        pages: file.pages,
        pageCount: file.pageCount,
        mode: file.mode,
        ...(file.sourceId
          ? {
              source: {
                id: file.sourceId,
                name: file.name,
                mime: file.kind === 'pdf' ? 'application/pdf' : 'application/octet-stream',
                size: 1,
              },
            }
          : {}),
        images: file.images.map((image) => ({
          file: { id: image.blobId, name: 'page.jpg', mime: 'image/jpeg', size: 1 },
          page: image.page,
        })),
      }));
    if (data.image) {
      const bytes = Buffer.from(data.image.split(',')[1], 'base64');
      const response = await page.request.post(
        `/api/files?name=screenshot.jpg&size=${bytes.length}`,
        {
          headers: { origin: 'http://127.0.0.1:8799' },
          data: bytes,
        },
      );
      user.image = await response.json();
    }
    const assistant: ChatMessage = {
      id: crypto.randomUUID(),
      sequence: ++sequence,
      role: 'assistant',
      status: options.interruptFirst && sent.length === 1 ? 'interrupted' : 'completed',
      ...(options.interruptFirst && sent.length === 1
        ? { error: '已达到本次回复长度上限，可点击「继续生成」。' }
        : {}),
      content:
        '# 结构要点\n\n这段资料介绍了桥梁的受力路径。\n\n- 桥面承受荷载，再传给主梁。\n- 支座将力传递到桥墩与基础。\n\n可以结合截图，逐项标注结构的位置。\n\n![示意图](https://assistant-tracker.invalid/pixel.png)',
      createdAt: Date.now(),
    };
    thread.messages.push(user, assistant);
    const events = [
      { type: 'start', user, assistant: { ...assistant, content: '', status: 'pending' } },
      { type: 'delta', content: assistant.content },
      assistant.error
        ? { type: 'error', error: assistant.error, message: assistant }
        : { type: 'done', message: assistant },
    ];
    await route.fulfill({
      contentType: 'text/event-stream',
      body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    });
  });
  return { threads, sent };
}
test('configures reply length and saves or continues an interrupted reply without sending the draft', async ({
  page,
}, info) => {
  await login(page);
  await page.request.delete('/api/ai/settings', { headers: { origin: 'http://127.0.0.1:8799' } });
  await nav(page, '设置');
  const limit = page.getByRole('combobox', { name: '单次回复上限', exact: true });
  await expect(limit).toHaveValue('8192');
  await page.getByLabel('DeepSeek API Key', { exact: true }).fill('sk-e2e-placeholder-key');
  await page.getByRole('button', { name: '保存 AI 配置', exact: true }).click();
  await expect(page.getByText('AI 配置已保存。', { exact: true })).toBeVisible();
  await limit.selectOption('16384');
  await page.getByRole('button', { name: '保存 AI 配置', exact: true }).click();
  await expect(page.getByText('AI 配置已保存。', { exact: true })).toBeVisible();
  await page.reload();
  await nav(page, '设置');
  await expect(limit).toHaveValue('16384');
  await expect(page.getByLabel('DeepSeek API Key', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: '测试连接', exact: true })).toBeEnabled();
  await limit.selectOption('8192');
  await page.getByRole('button', { name: '保存 AI 配置', exact: true }).click();
  await expect(page.getByText('AI 配置已保存。', { exact: true })).toBeVisible();

  const { node } = await assistantSeed(page, {
    kind: 'markdown',
    title: '继续阅读',
    content: '# 正文\n\n待发送的附件。',
  });
  const fixture = await assistantFixture(page, { interruptFirst: true });
  await page.goto(`/n/${node.id}`);
  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  const panel = page.getByRole('complementary', { name: '文件 AI 助手', exact: true });
  const prompt = panel.getByRole('textbox', { name: '发给助手的问题' });
  await prompt.fill('详细解释。');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  const reply = panel.locator('.chat-assistant').first();
  await expect(reply.getByRole('button', { name: '继续生成', exact: true })).toBeEnabled();
  await reply.getByRole('button', { name: '保存为子笔记', exact: true }).click();
  await expect(reply.getByRole('button', { name: '打开子笔记', exact: true })).toBeVisible();
  const partial = fixture.threads.get(node.id)!.messages[1];
  const saved = await (await page.request.get(`/api/nodes/${partial.exportedNodeId}`)).json();
  expect(saved).toMatchObject({ parent_id: node.id, kind: 'markdown', content: partial.content });
  await prompt.fill('下一条问题草稿');
  await panel.getByRole('button', { name: '附上当前文件', exact: true }).click();
  await page
    .getByRole('dialog', { name: '附上文件', exact: true })
    .getByRole('button', { name: '附到对话', exact: true })
    .click();
  await reply.getByRole('button', { name: '继续生成', exact: true }).click();
  await expect(panel.locator('.chat-assistant')).toHaveCount(2);
  await expect(
    panel
      .locator('.chat-assistant')
      .last()
      .getByRole('button', { name: '保存为子笔记', exact: true }),
  ).toBeVisible();
  expect(fixture.sent[1]).toEqual({ content: '继续生成', continueFrom: partial.id });
  await expect(prompt).toHaveValue('下一条问题草稿');
  await expect(panel.locator('.context-file')).toHaveCount(1);
  await page.screenshot({ path: `test-results/assistant-continue-${info.project.name}.png` });
  await page.reload();
  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  await expect(panel.locator('.chat-assistant')).toHaveCount(2);
  await expect(panel.getByRole('button', { name: '打开子笔记', exact: true })).toBeVisible();
});

async function assistantSeed(page: Page, data: Record<string, unknown>) {
  const headers = { origin: 'http://127.0.0.1:8799' };
  const node = await (
    await page.request.post('/api/nodes', {
      headers,
      data,
    })
  ).json();
  return { node };
}

async function paperImportFixture(page: Page, source = paperHtml, svg?: string) {
  const headers = { origin: 'http://127.0.0.1:8799' };
  const bytes = svg ? Buffer.from(svg) : Buffer.from(paperPng, 'base64');
  const image = await (
    await page.request.post(`/api/files?name=figure.${svg ? 'svg' : 'png'}&size=${bytes.length}`, {
      headers,
      data: bytes,
    })
  ).json();
  let paper: any;
  await page.route('**/api/import/arxiv', async (route) => {
    const input = route.request().postDataJSON();
    const response = await page.request.post('/api/nodes', {
      headers,
      data: {
        kind: 'link',
        title: input.title || 'A paper & its equations',
        url: 'https://arxiv.org/html/2503.01800v1',
        parentId: input.parentId,
      },
    });
    const node = await response.json();
    const detail = await (await page.request.get(`/api/nodes/${node.id}`)).json();
    // The Worker suite tests extraction/download/retention. Here the transport
    // fixture exercises the importer UI and treats saved HTML as untrusted.
    const body = source.match(/<article[\s\S]*<\/article>/)![0];
    paper = {
      ...detail,
      arxiv_id: '2503.01800v1',
      content: body.replaceAll('2503.01800v1/figure.png', `/api/files/${image.id}`),
      attachments: [image],
    };
    await page.route(`**/api/nodes/${node.id}`, (request) =>
      request.request().method() === 'GET' ? request.fulfill({ json: paper }) : request.fallback(),
    );
    await route.fulfill({ status: 201, json: paper });
  });
  return {
    get paper() {
      return paper;
    },
  };
}

async function bluePixels(image: Locator): Promise<number> {
  return image.evaluate(async (element) => {
    const image = element as HTMLImageElement;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let blue = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i] < 90 && pixels[i + 2] > 220 && pixels[i + 3] > 200) blue++;
    return blue;
  });
}

test('SVG paper diagrams remain vector images and appear in screenshots and AI attachments', async ({
  page,
}, info) => {
  await login(page);
  await page.request.put('/api/ai/settings', {
    headers: { origin: 'http://127.0.0.1:8799' },
    data: { apiKey: 'sk-e2e-placeholder-key' },
  });
  const fixture = await paperImportFixture(page, paperHtml, hostileSvg);
  const chat = await assistantFixture(page);
  const external: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('svg-tracker.invalid')) external.push(request.url());
  });
  await page.getByRole('button', { name: '新建', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新建节点' });
  await form.getByRole('radio', { name: 'arXiv 论文', exact: true }).check();
  await form
    .getByLabel('arXiv 论文地址', { exact: true })
    .fill('https://arxiv.org/html/2503.01800v1');
  await form.getByRole('button', { name: '导入论文', exact: true }).click();
  const diagram = page.locator('.paper-body img');
  await expect(diagram).toHaveCount(1);
  expect(fixture.paper.attachments[0].mime).toBe('image/svg+xml');
  await expect.poll(() => bluePixels(diagram)).toBeGreaterThan(1000);
  await diagram.click();
  const zoom = page.getByRole('dialog', { name: 'Paper diagram', exact: true });
  await expect(zoom).toBeVisible();
  await zoom.getByRole('button', { name: '放大图片', exact: true }).click();
  await expect(zoom.locator('.image-stage img')).toHaveCSS('transform', /matrix\(1.25/);
  expect(await bluePixels(zoom.locator('img'))).toBeGreaterThan(1000);
  await page.screenshot({ path: `test-results/svg-zoom-${info.project.name}.png` });
  await zoom.getByRole('button', { name: '关闭', exact: true }).click();
  await diagram.evaluate((image) => image.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  await page.getByRole('button', { name: '框选截图', exact: true }).click();
  const crop = page.getByRole('dialog', { name: '框选截图', exact: true });
  await expect(crop).toBeVisible();
  expect(await bluePixels(crop.getByAltText('当前阅读区截图'))).toBeGreaterThan(1000);
  await page.screenshot({ path: `test-results/svg-capture-${info.project.name}.png` });
  await crop.getByRole('button', { name: '选择整个阅读区', exact: true }).click();
  await crop.getByRole('button', { name: '采用截图', exact: true }).click();
  expect(await bluePixels(page.getByAltText('待发送截图'))).toBeGreaterThan(1000);
  await page
    .getByLabel('选择聊天附件', { exact: true })
    .setInputFiles({
      name: 'plot.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(hostileSvg),
    });
  const file = page.getByRole('dialog', { name: '附上文件', exact: true });
  await expect(file.getByAltText('文件图片预览')).toBeVisible();
  expect(await bluePixels(file.getByAltText('文件图片预览'))).toBeGreaterThan(1000);
  await file.getByRole('button', { name: '附到对话', exact: true }).click();
  await page.getByRole('textbox', { name: '发给助手的问题' }).fill('解释 SVG 图中的曲线。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.chat-assistant')).toContainText('结构要点');
  expect(chat.sent[0].image).toMatch(/^data:image\/jpeg;base64,/);
  const attached = chat.sent[0].files![0];
  expect(attached.kind).toBe('image');
  expect(
    (await page.request.get(`/api/files/${attached.sourceId}`)).headers()['content-type'],
  ).toBe('image/svg+xml');
  expect(
    (await page.request.get(`/api/files/${attached.images[0].blobId}`)).headers()['content-type'],
  ).toBe('image/jpeg');
  expect(external).toEqual([]);
  expect(await page.evaluate(() => (window as any).svgInjected)).toBeUndefined();
});

test('imports an arXiv paper for reading, MathML, citations, saved position and its file assistant', async ({
  page,
}, info) => {
  await login(page);
  await page.request.put('/api/ai/settings', {
    headers: { origin: 'http://127.0.0.1:8799' },
    data: { apiKey: 'sk-e2e-placeholder-key' },
  });
  const attacks = `<p class="app-header" style="position:fixed;inset:0" onclick="window.paperInjected=true">Untrusted styled text.</p><img src="https://paper-tracker.invalid/pixel.png" onerror="window.paperInjected=true"><a href="javascript:window.paperInjected=true">Bad link</a><math><annotation-xml encoding="text/html"><img src="x" onerror="window.paperInjected=true"></annotation-xml></math>`;
  const fixture = await paperImportFixture(
    page,
    paperHtml.replace('</article>', attacks + '</article>'),
  );
  const chat = await assistantFixture(page);
  const remoteImages: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('paper-tracker.invalid')) remoteImages.push(request.url());
  });
  await page.getByRole('button', { name: '新建', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新建节点' });
  await form.getByRole('radio', { name: 'arXiv 论文', exact: true }).check();
  await form
    .getByLabel('arXiv 论文地址', { exact: true })
    .fill('https://arxiv.org/html/2503.01800v1');
  await form.getByRole('button', { name: '导入论文', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'A paper & its equations', exact: true }),
  ).toHaveCount(1);
  const paper = page.locator('.paper-body');
  await expect(paper.locator('math').first()).toBeVisible();
  await expect(paper).toContainText('Test Author');
  await expect(
    paper.locator('script,style,iframe,nav,form,[onclick],.app-header,annotation-xml'),
  ).toHaveCount(0);
  expect(remoteImages).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).paperInjected)).toBeUndefined();
  await expect(page.getByRole('button', { name: '编辑正文', exact: true })).toHaveCount(0);
  await expect(page.locator('.app-header')).toHaveCount(0);
  await expect(page.locator('iframe,embed,object')).toHaveCount(0);
  const href = page.url();
  await paper.getByRole('link', { name: 'Equation 1', exact: true }).click();
  await expect
    .poll(() => page.locator('.note-scroll').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(500);
  expect(page.url()).toBe(href);
  // Reading updates flush on page hide, navigation, or the 30-second timer.
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/nodes/${fixture.paper.id}/reading`)).json()).position
          .ratio || 0,
    )
    .toBeGreaterThan(0);
  const position = await page.locator('.note-scroll').evaluate((el) => el.scrollTop);
  await page.reload();
  await expect(paper.locator('math').first()).toBeAttached();
  await expect
    .poll(() => page.locator('.note-scroll').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(position * 0.8);
  if (info.project.name === 'mobile')
    await page.getByRole('button', { name: '标题目录', exact: true }).click();
  const toc =
    info.project.name === 'mobile'
      ? page.getByRole('dialog', { name: '标题目录', exact: true })
      : page.locator('.desktop-toc');
  await toc.getByRole('button', { name: '1 Introduction', exact: true }).click();
  await paper.getByRole('button', { name: '放大图片：Paper diagram', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Paper diagram', exact: true })).toBeVisible();
  await page
    .getByRole('dialog', { name: 'Paper diagram', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await paper
    .locator('math')
    .first()
    .evaluate((math) => {
      const range = document.createRange();
      range.selectNode(math);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  await page.getByRole('button', { name: '引用选中文字', exact: true }).click();
  await expect(page.locator('.context-quote')).toContainText('$E=mc^2$');
  await cropInBrowser(page, info.project.name === 'mobile');
  await page.getByRole('button', { name: '附上当前文件', exact: true }).click();
  const file = page.getByRole('dialog', { name: '附上文件', exact: true });
  await file.getByText('查看将发送的文字', { exact: true }).click();
  await expect(file.locator('pre')).toContainText('\\int_0^1 x^2 dx=\\frac{1}{3}');
  await file.getByRole('button', { name: '附到对话', exact: true }).click();
  await page.getByRole('textbox', { name: '发给助手的问题' }).fill('解释这篇论文的公式。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.chat-assistant')).toContainText('结构要点');
  expect(chat.sent[0].quote).toContain('$E=mc^2$');
  expect(chat.sent[0].files![0].text).toContain('arXiv:2503.01800v1');
  await page.getByRole('button', { name: '保存为子笔记', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开子笔记', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭助手', exact: true }).click();
  for (const theme of ['light', 'dark', 'starry']) {
    await selectTheme(page, theme);
    await page.screenshot({ path: `test-results/arxiv-${theme}-${info.project.name}.png` });
  }
});

test('long arXiv papers attach a chosen section without silently truncating the full text', async ({
  page,
}) => {
  await login(page);
  await page.request.put('/api/ai/settings', {
    headers: { origin: 'http://127.0.0.1:8799' },
    data: { apiKey: 'sk-e2e-placeholder-key' },
  });
  await paperImportFixture(
    page,
    paperHtml.replace('The proof continues', 'Long text '.repeat(6100) + 'The proof continues'),
  );
  await assistantFixture(page);
  await page.getByRole('button', { name: '新建', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新建节点' });
  await form.getByRole('radio', { name: 'arXiv 论文', exact: true }).check();
  await form
    .getByLabel('arXiv 论文地址', { exact: true })
    .fill('https://arxiv.org/abs/2503.01800v1');
  await form.getByRole('button', { name: '导入论文', exact: true }).click();
  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  await page.getByRole('button', { name: '附上当前文件', exact: true }).click();
  const file = page.getByRole('dialog', { name: '附上文件', exact: true });
  const range = file.getByRole('combobox', { name: '论文范围', exact: true });
  await expect(range).toHaveValue('');
  await expect(range.locator('option[value="all"]')).toHaveJSProperty('disabled', true);
  await range.selectOption('section-0');
  await file.getByText('查看将发送的文字', { exact: true }).click();
  await expect(file.locator('pre')).toContainText('1 Introduction');
  await expect(file.locator('pre')).not.toContainText('The proof continues');
  await expect(file.getByRole('button', { name: '附到对话', exact: true })).toBeEnabled();
});

async function cropInBrowser(page: Page, mobile: boolean) {
  await page.getByRole('button', { name: '框选截图', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '框选截图', exact: true });
  await expect(dialog).toBeVisible();
  const box = (await dialog.locator('.capture-stage').boundingBox())!;
  const start = { x: box.x + box.width * 0.07, y: box.y + box.height * 0.06 };
  const end = { x: box.x + box.width * 0.93, y: box.y + box.height * 0.7 };
  if (mobile) {
    const session = await page.context().newCDPSession(page);
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [start],
    });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [end] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await session.detach();
  } else {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 8 });
    await page.mouse.up();
  }
  await expect(dialog.getByRole('button', { name: '采用截图' })).toBeEnabled();
  await page.screenshot({
    path: `test-results/assistant-crop-${mobile ? 'mobile' : 'desktop'}.png`,
  });
  await dialog.getByRole('button', { name: '采用截图' }).click();
  await expect(page.getByAltText('待发送截图')).toBeVisible();
}

test('assistant floats, docks and maximizes while keeping drafts, attachments and reading layout', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  const { node } = await assistantSeed(page, {
    kind: 'markdown',
    title: `窗口模式 · ${info.project.name}`,
    content: '# 阅读与对话\n\n保持正文宽度，边读边问。\n\n## 记录\n\n浮窗可以移到合适的位置。',
  });
  await page.request.put('/api/ai/settings', {
    headers: { origin: 'http://127.0.0.1:8799' },
    data: { apiKey: 'sk-e2e-placeholder-key' },
  });
  const fixture = await assistantFixture(page);
  await page.goto(`/n/${node.id}`);
  const workspace = page.locator('.note-workspace');
  const launcher = page.getByRole('button', { name: '打开文件助手', exact: true });
  await expect(launcher).toBeVisible();
  const original = (await workspace.boundingBox())!;
  await launcher.click();
  const panel = page.getByRole('complementary', { name: '文件 AI 助手', exact: true });
  const input = panel.getByRole('textbox', { name: '发给助手的问题', exact: true });
  await expect(panel).toBeVisible();
  await expect.poll(async () => (await workspace.boundingBox())!.width).toBe(original.width);
  const floating = (await panel.boundingBox())!;
  expect(floating.height).toBeLessThan(page.viewportSize()!.height);
  await input.fill('切换窗口后继续这个问题。');
  await panel.getByRole('button', { name: '附上当前文件', exact: true }).click();
  const attachment = page.getByRole('dialog', { name: '附上文件', exact: true });
  await attachment.getByRole('button', { name: '附到对话', exact: true }).click();
  const handle = panel.getByRole('group', { name: '移动助手窗口' });
  const grip = (await handle.boundingBox())!;
  const start = { x: grip.x + 25, y: grip.y + grip.height / 2 };
  const end = { x: start.x - (info.project.name === 'mobile' ? 0 : 170), y: start.y - 90 };
  if (info.project.name === 'mobile') {
    const session = await page.context().newCDPSession(page);
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [start],
    });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [end] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await session.detach();
  } else {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 6 });
    await page.mouse.up();
  }
  await expect
    .poll(async () => Math.round((await panel.boundingBox())!.y))
    .toBe(Math.round(floating.y - 90));
  const moved = (await panel.boundingBox())!;
  await handle.focus();
  await page.keyboard.press('ArrowUp');
  await expect
    .poll(async () => Math.round((await panel.boundingBox())!.y))
    .toBe(Math.round(moved.y - 10));
  const position = (await panel.boundingBox())!;
  await page.screenshot({ path: `test-results/assistant-floating-${info.project.name}.png` });

  await panel.getByRole('button', { name: '贴边助手', exact: true }).click();
  const area = (await page.locator('.reading-with-assistant').boundingBox())!;
  await expect
    .poll(async () => Math.round((await panel.boundingBox())!.y))
    .toBe(Math.round(area.y));
  const docked = (await panel.boundingBox())!;
  expect(Math.round(docked.x + docked.width)).toBe(Math.round(area.x + area.width));
  expect(Math.round(docked.height)).toBe(Math.round(area.height));
  expect((await workspace.boundingBox())!.width).toBe(
    info.project.name === 'desktop' ? original.width - 400 : original.width,
  );
  await page.screenshot({ path: `test-results/assistant-docked-${info.project.name}.png` });

  await panel.getByRole('button', { name: '最大化助手', exact: true }).click();
  await expect
    .poll(async () => (await panel.boundingBox())!.width)
    .toBe(page.viewportSize()!.width);
  const full = (await panel.boundingBox())!;
  expect(full.x).toBe(0);
  expect(full.y).toBe(0);
  expect(full.height).toBe(page.viewportSize()!.height);
  await expect(input).toHaveValue('切换窗口后继续这个问题。');
  await expect(panel.locator('.context-file')).toHaveCount(1);
  const send = panel.getByRole('button', { name: '发送', exact: true });
  await expect(send).toBeEnabled();
  await send.focus();
  await page.keyboard.press('Tab');
  await expect(panel.getByRole('button', { name: '刷新会话', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(send).toBeFocused();
  await panel.getByRole('button', { name: '附上当前文件', exact: true }).click();
  await expect(attachment).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(attachment).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '还原助手', exact: true })).toBeVisible();
  await page.screenshot({ path: `test-results/assistant-maximized-${info.project.name}.png` });
  await panel.getByRole('button', { name: '还原助手', exact: true }).click();
  await expect(panel.getByRole('button', { name: '悬浮助手', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '悬浮助手', exact: true }).click();
  expect(await panel.boundingBox()).toEqual(position);
  await panel.getByRole('button', { name: '最大化助手', exact: true }).click();
  await page.keyboard.press('Escape');
  expect(await panel.boundingBox()).toEqual(position);

  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: 320, height: 560 });
  await expect.poll(async () => (await panel.boundingBox())!.width).toBe(296);
  const small = (await panel.boundingBox())!;
  expect(small.x).toBeGreaterThanOrEqual(0);
  expect(small.y).toBeGreaterThanOrEqual(0);
  expect(small.x + small.width).toBeLessThanOrEqual(320);
  expect(small.y + small.height).toBeLessThanOrEqual(560);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await page.setViewportSize({ width: 320, height: 300 });
  await panel.getByRole('button', { name: '贴边助手', exact: true }).click();
  await send.scrollIntoViewIfNeeded();
  await expect(send).toBeInViewport({ ratio: 1 });
  await expect(panel.getByRole('button', { name: '最大化助手', exact: true })).toBeInViewport();
  await panel.getByRole('button', { name: '悬浮助手', exact: true }).click();
  await page.setViewportSize(viewport);
  await panel.getByRole('button', { name: '关闭助手', exact: true }).click();
  await expect(launcher).toBeVisible();
  await expect.poll(async () => (await workspace.boundingBox())!.width).toBe(original.width);
  await launcher.click();
  await expect(input).toHaveValue('切换窗口后继续这个问题。');
  await expect(panel.locator('.context-file')).toHaveCount(1);
  await send.click();
  await expect(panel.locator('.chat-assistant')).toContainText('结构要点');
  expect(fixture.sent).toHaveLength(1);
  expect(fixture.sent[0].files).toHaveLength(1);
  await panel.getByRole('button', { name: '最大化助手', exact: true }).click();
  await panel.getByRole('button', { name: '保存为子笔记', exact: true }).click();
  await expect(panel.getByRole('button', { name: '打开子笔记', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('file assistant quotes, crops, previews, exports and retains independent conversations', async ({
  page,
}, info) => {
  const errors: string[] = [];
  const remoteImages: string[] = [];
  const unlocks: unknown[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.url().includes('assistant-tracker.invalid')) remoteImages.push(request.url());
    if (new URL(request.url()).pathname === '/api/edit/unlock')
      unlocks.push(request.postDataJSON());
  });
  await login(page);
  await nav(page, '设置');
  await page.getByLabel('DeepSeek API Key', { exact: true }).fill('sk-e2e-placeholder-key');
  await page.getByRole('button', { name: '保存 AI 配置', exact: true }).click();
  await expect(page.getByText('AI 配置已保存。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('DeepSeek API Key', { exact: true })).toHaveValue('');
  await page.route('**/api/ai/test', (route) => route.fulfill({ json: { ok: true } }));
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(page.getByText('连接成功。', { exact: true })).toBeVisible();
  const content =
    '# 桥梁结构\n\n桥面承受荷载，通过主梁、支座传递给桥墩与基础。\n\n## 阅读记录\n\n| 构件 | 作用 |\n| --- | --- |\n| 主梁 | 传递荷载 |\n| 支座 | 连接上下部结构 |';
  const { node } = await assistantSeed(page, {
    kind: 'markdown',
    title: `桥梁阅读 · ${info.project.name}`,
    content,
  });
  const { node: other } = await assistantSeed(page, {
    kind: 'text',
    title: `独立会话 · ${info.project.name}`,
    content: '另一个文件。',
  });
  const fixture = await assistantFixture(page);
  await page.goto(`/n/${node.id}`);
  await expect(page.locator('.read-content p').first()).toBeVisible();
  await page
    .locator('.read-content p')
    .first()
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  await page.getByRole('button', { name: '引用选中文字', exact: true }).click();
  await expect(page.locator('.context-quote')).toContainText('桥面承受荷载');
  await cropInBrowser(page, info.project.name === 'mobile');
  await page.getByAltText('待发送截图').click();
  await expect(page.getByRole('dialog', { name: '待发送截图', exact: true })).toBeVisible();
  await page
    .getByRole('dialog', { name: '待发送截图', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: '发给助手的问题' })
    .fill('结合引用与截图，整理结构要点。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const panel = page.getByRole('complementary', { name: '文件 AI 助手' });
  await expect(panel.getByRole('heading', { name: '结构要点', exact: true })).toBeVisible();
  expect(fixture.sent[0].quote).toBe('桥面承受荷载，通过主梁、支座传递给桥墩与基础。');
  expect(fixture.sent[0].image).toMatch(/^data:image\/jpeg;base64,/);
  expect(
    Buffer.from(fixture.sent[0].image!.split(',')[1], 'base64').length,
  ).toBeLessThanOrEqual(1048576);
  expect(remoteImages).toEqual([]);
  await expectPreview(page);
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  for (const theme of ['light', 'dark', 'starry']) {
    await selectTheme(page, theme);
    await page.screenshot({ path: `test-results/assistant-${theme}-${info.project.name}.png` });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await panel.getByRole('button', { name: '保存为子笔记', exact: true }).click();
  await expect(panel.getByRole('button', { name: '打开子笔记', exact: true })).toBeVisible();
  const savedId = fixture.threads.get(node.id)!.messages[1].exportedNodeId!;
  const saved = await (await page.request.get(`/api/nodes/${savedId}`)).json();
  expect(saved.parent_id).toBe(node.id);
  expect(saved.kind).toBe('markdown');
  expect(saved.content).toContain('# 结构要点');
  expect((await (await page.request.get(`/api/nodes/${node.id}`)).json()).content).toBe(
    content,
  );
  await page.reload();
  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  await expect(panel.getByRole('button', { name: '打开子笔记', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '清空会话', exact: true }).click();
  const clear = page.getByRole('dialog', { name: '清空这个文件的会话？', exact: true });
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await clear.getByRole('button', { name: '取消', exact: true }).click();
  await expect(panel.getByRole('button', { name: '打开子笔记', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '清空会话', exact: true }).click();
  await clear.getByRole('button', { name: '清空会话', exact: true }).click();
  await expect(panel.locator('.chat-message')).toHaveCount(0);
  expect((await (await page.request.get(`/api/nodes/${savedId}`)).json()).content).toBe(
    saved.content,
  );
  await page.goto(`/n/${other.id}`);
  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  await expect(page.locator('.chat-message')).toHaveCount(0);
  await expect(page.getByText('附上文件、选中文字或截图，开始提问。')).toBeVisible();
  await page.getByRole('button', { name: '关闭助手', exact: true }).click();
  await nav(page, '设置');
  await page.getByRole('button', { name: '清除配置', exact: true }).click();
  await page
    .getByRole('dialog', { name: '清除 AI 配置？', exact: true })
    .getByRole('button', { name: '清除配置', exact: true })
    .click();
  await expect(page.getByText('AI 配置已清除。', { exact: true })).toBeVisible();
  expect(unlocks).toEqual([]);
  expect(errors).toEqual([]);
});

test('chat attachments preview current notes and local text or images before sending', async ({
  page,
}, info) => {
  await login(page);
  const content = '# 当前文件全文\n\n只有主动附上后，助手才会收到这段内容。';
  const { node } = await assistantSeed(page, {
    kind: 'markdown',
    title: '文件对照阅读',
    content,
  });
  await page.request.put('/api/ai/settings', {
    headers: { origin: 'http://127.0.0.1:8799' },
    data: { apiKey: 'sk-e2e-placeholder-key' },
  });
  const fixture = await assistantFixture(page);
  const uploads: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/assistant/files')) uploads.push(request.url());
  });
  await page.goto(`/n/${node.id}`);
  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  await page.getByRole('button', { name: '附上当前文件', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '附上文件', exact: true });
  await dialog.getByText('查看将发送的文字', { exact: true }).click();
  await expect(dialog.locator('pre')).toHaveText(content);
  await dialog.getByRole('button', { name: '附到对话', exact: true }).click();
  await page.getByLabel('选择聊天附件', { exact: true }).setInputFiles({
    name: '对照.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('另一份本地参考资料。'),
  });
  await expect(dialog.getByRole('button', { name: '附到对话' })).toBeEnabled();
  await dialog.getByRole('button', { name: '附到对话' }).click();
  const picture = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 80;
    canvas.height = 50;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#427aa8';
    context.fillRect(0, 0, 80, 50);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.getByLabel('选择聊天附件', { exact: true }).setInputFiles({
    name: '图片.png',
    mimeType: 'image/png',
    buffer: Buffer.from(picture, 'base64'),
  });
  await expect(dialog.getByAltText('文件图片预览')).toBeVisible();
  await dialog.getByRole('button', { name: '附到对话' }).click();
  await expect(page.locator('.context-file')).toHaveCount(3);
  await expect(page.getByRole('button', { name: '另选文件', exact: true })).toBeDisabled();
  expect(uploads).toHaveLength(0);
  expect(fixture.sent).toHaveLength(0);
  await page.screenshot({ path: `test-results/file-attachments-${info.project.name}.png` });
  await page.getByRole('button', { name: '移除附件 图片.png', exact: true }).click();
  await page.getByRole('textbox', { name: '发给助手的问题' }).fill('比较两份资料。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.chat-assistant')).toContainText('结构要点');
  expect(fixture.sent[0].files).toHaveLength(2);
  expect(fixture.sent[0].files![0]).toMatchObject({
    kind: 'markdown',
    text: content,
    images: [],
  });
  expect(fixture.sent[0].files![1]).toMatchObject({
    name: '对照.txt',
    text: '另一份本地参考资料。',
    sourceId: expect.any(String),
  });
  expect(uploads).toHaveLength(1);
  await expect(page.locator('.context-file')).toHaveCount(0);
  await expectPreview(page);
  await page.reload();
  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  await expect(page.locator('.chat-file-card')).toHaveCount(2);
  await page.locator('.chat-file-card').first().locator('summary').click();
  await expect(page.locator('.chat-file-card').first().locator('pre')).toHaveText(content);
  expect((await (await page.request.get(`/api/nodes/${node.id}`)).json()).content).toBe(
    content,
  );
});

test('PDF attachments select pages, extract text and send page images with source references', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  await assistantSeed(page, { kind: 'folder', title: 'PDF 附件测试' });
  const headers = { origin: 'http://127.0.0.1:8799' };
  await page.request.put('/api/ai/settings', {
    headers,
    data: { apiKey: 'sk-e2e-placeholder-key' },
  });
  const bytes = pdfFixture(8);
  const file = await (
    await page.request.post(`/api/files?name=current.pdf&size=${bytes.length}`, {
      headers,
      data: bytes,
    })
  ).json();
  const node = await (
    await page.request.post('/api/nodes', {
      headers,
      data: { kind: 'pdf', title: 'PDF 原文件', fileId: file.id },
    })
  ).json();
  const fixture = await assistantFixture(page);
  await page.goto(`/n/${node.id}`);
  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  await page.getByRole('button', { name: '附上当前文件', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '附上文件', exact: true });
  await dialog.getByLabel('页码范围', { exact: true }).fill('2-3');
  await dialog.getByRole('button', { name: '处理所选页面', exact: true }).click();
  await dialog.getByText('查看将发送的文字', { exact: true }).click();
  await expect(dialog.locator('pre')).toContainText('[第 2 页]');
  await expect(dialog.locator('pre')).toContainText('A quiet page - 3');
  await expect(dialog.locator('pre')).not.toContainText('A quiet page - 1');
  await dialog.getByRole('button', { name: '附到对话' }).click();
  await page
    .getByLabel('选择聊天附件')
    .setInputFiles({ name: 'charts.pdf', mimeType: 'application/pdf', buffer: bytes });
  await page.getByLabel('页码范围', { exact: true }).waitFor();
  await dialog
    .getByRole('combobox', { name: 'PDF 处理方式', exact: true })
    .selectOption('images');
  await dialog.getByRole('button', { name: '处理所选页面' }).click();
  await expect(dialog.getByRole('alert')).toContainText('最多 6 页');
  await dialog.getByLabel('页码范围').fill('1,4');
  await dialog.getByRole('button', { name: '处理所选页面' }).click();
  await expect(dialog.getByAltText('第 4 页预览')).toBeVisible();
  await page.screenshot({ path: `test-results/pdf-file-preview-${info.project.name}.png` });
  expect(fixture.sent).toHaveLength(0);
  await dialog.getByRole('button', { name: '附到对话' }).click();
  await page
    .getByRole('textbox', { name: '发给助手的问题' })
    .fill('解释这些页面，并注明页码。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.chat-assistant')).toContainText('结构要点');
  const files = fixture.sent[0].files!;
  expect(files[0]).toMatchObject({
    sourceId: file.id,
    pages: [2, 3],
    pageCount: 8,
    mode: 'auto',
    images: [],
  });
  expect(files[1]).toMatchObject({ pages: [1, 4], mode: 'images', text: '' });
  expect(files[1].images.map((image) => image.page)).toEqual([1, 4]);
  for (const image of files[1].images) {
    const response = await page.request.get(`/api/files/${image.blobId}`);
    expect(response.headers()['content-type']).toBe('image/jpeg');
    expect((await response.body()).length).toBeLessThanOrEqual(1_048_576);
  }
  await page.locator('.chat-file-card').last().locator('summary').click();
  await page.getByRole('button', { name: '查看 charts.pdf 第 4 页', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'charts.pdf · 第 4 页', exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('PDF attachments automatically render pages without text and reject invalid page ranges', async ({
  page,
}, info) => {
  await login(page);
  const { node } = await assistantSeed(page, {
    kind: 'text',
    title: '扫描文档对话',
    content: '阅读扫描件。',
  });
  await page.request.put('/api/ai/settings', {
    headers: { origin: 'http://127.0.0.1:8799' },
    data: { apiKey: 'sk-e2e-placeholder-key' },
  });
  const fixture = await assistantFixture(page);
  await page.goto(`/n/${node.id}`);
  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  await page.getByLabel('选择聊天附件').setInputFiles({
    name: 'scan.pdf',
    mimeType: 'application/pdf',
    buffer: pdfFixture(2, false, true),
  });
  const dialog = page.getByRole('dialog', { name: '附上文件', exact: true });
  await dialog.getByLabel('页码范围').fill('3');
  await dialog.getByRole('button', { name: '处理所选页面' }).click();
  await expect(dialog.getByRole('alert')).toContainText('1–2');
  await dialog.getByLabel('页码范围').fill('2');
  await dialog.getByRole('button', { name: '处理所选页面' }).click();
  await expect(dialog.getByAltText('第 2 页预览')).toBeVisible();
  await expect(dialog.locator('.chat-file-preview')).toContainText('0 字符 · 1 张图片');
  await dialog.getByRole('button', { name: '附到对话' }).click();
  await page.getByRole('textbox', { name: '发给助手的问题' }).fill('概括扫描件。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.chat-assistant')).toContainText('结构要点');
  expect(fixture.sent[0].files![0]).toMatchObject({
    pages: [2],
    mode: 'auto',
    text: '',
    images: [{ page: 2, blobId: expect.any(String) }],
  });
  await page.screenshot({ path: `test-results/scan-attachment-${info.project.name}.png` });
});

test('PDF assistant can select text and crop the continuous viewer', async ({ page }, info) => {
  await login(page);
  await assistantSeed(page, {
    kind: 'folder',
    title: `PDF 助手测试 · ${info.project.name}`,
  });
  const headers = { origin: 'http://127.0.0.1:8799' };
  await page.request.put('/api/ai/settings', {
    headers,
    data: { apiKey: 'sk-e2e-placeholder-key' },
  });
  const bytes = pdfFixture(4);
  const file = await (
    await page.request.post(`/api/files?name=reading.pdf&size=${bytes.length}`, {
      headers,
      data: bytes,
    })
  ).json();
  const node = await (
    await page.request.post('/api/nodes', {
      headers,
      data: { kind: 'pdf', title: '连续阅读 PDF', fileId: file.id },
    })
  ).json();
  const fixture = await assistantFixture(page);
  await page.goto(`/n/${node.id}`);
  const text = page
    .locator('.pdf-text-layer span')
    .filter({ hasText: 'A quiet page - 1' })
    .first();
  await expect(text).toBeAttached();
  await text.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  await page.getByRole('button', { name: '引用选中文字', exact: true }).click();
  await expect(page.locator('.context-quote')).toContainText('A quiet page - 1');
  await page.getByRole('button', { name: '最大化助手', exact: true }).click();
  await cropInBrowser(page, info.project.name === 'mobile');
  await expect(page.getByRole('button', { name: '还原助手', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '发给助手的问题' }).fill('解释这一页。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.chat-assistant')).toContainText('结构要点');
  expect(fixture.sent[0].quote).toBe('A quiet page - 1');
  await page.getByRole('button', { name: '保存为子笔记', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开子笔记', exact: true })).toBeVisible();
  const saved = fixture.threads.get(node.id)!.messages[1].exportedNodeId!;
  expect((await (await page.request.get(`/api/nodes/${saved}`)).json()).parent_id).toBe(
    node.id,
  );
  await page.getByRole('button', { name: '关闭助手', exact: true }).click();
  await expect(page.locator('.pdf-scroll')).toBeVisible();
  await expect(page.locator('iframe,embed,object')).toHaveCount(0);
  await page.screenshot({ path: `test-results/pdf-assistant-${info.project.name}.png` });
});
