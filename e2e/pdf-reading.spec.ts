import { expect, test, type Page } from './fixtures';
import { noteAction } from './note-actions';
import { expectPreview, login, createNote, edit, selectTheme, nav } from './notebook-helpers';
import { pdfFixture } from './pdf-fixtures';

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
  await page.getByLabel('上传附件', { exact: true }).setInputFiles({
    name: 'reading.pdf',
    mimeType: 'application/pdf',
    buffer: pdfFixture(2, false, false, true),
  });
  await expect(page.getByText('上传中…')).toHaveCount(0);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('.attachment-name').filter({ hasText: 'reading.pdf' }).click();
  const pdfDialog = page.getByRole('dialog', { name: 'reading.pdf' });
  await expect(pdfDialog.locator('canvas').first()).toBeVisible();
  await expect(pdfDialog.locator('.pdf-page').first()).toHaveAttribute('aria-busy', 'false');
  await pdfDialog.getByRole('button', { name: 'PDF 目录', exact: true }).click();
  await expect(pdfDialog.getByRole('navigation', { name: 'PDF 目录', exact: true })).toContainText(
    '1 Introduction',
  );
  await page.keyboard.press('Escape');
  await expect(pdfDialog).toBeVisible();
  await expect(pdfDialog.getByRole('button', { name: 'PDF 目录', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
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
  // The ⋯ menu opens all attachments in a dialog, besides the list under the body.
  await noteAction(page, '所有附件（1）');
  await page
    .getByRole('dialog', { name: '所有附件（1）' })
    .locator('.attachment-name')
    .filter({ hasText: 'pixel.png' })
    .click();
  await expect(page.getByRole('dialog', { name: '所有附件（1）' })).toHaveCount(0);
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
  const uploaded = await page.request.post(`/api/files?name=continuous.pdf&size=${buffer.length}`, {
    headers: { ...headers, 'content-type': 'application/pdf' },
    data: buffer,
  });
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
  await expect(page.locator('.note-scroll, .document-heading, iframe, .cm-editor')).toHaveCount(0);
  const workspace = (await page.locator('.note-workspace').boundingBox())!;
  const reader = (await viewer.boundingBox())!;
  expect(reader.width).toBeCloseTo(workspace.width, 0);
  expect(reader.height).toBeCloseTo(workspace.height, 0);
  const toolbarTop = (await viewer.locator('.pdf-toolbar').boundingBox())!.y;
  await viewer.getByRole('button', { name: 'PDF 目录', exact: true }).click();
  await expect(viewer.getByText('此 PDF 没有内置目录。', { exact: true })).toBeVisible();
  await viewer.getByRole('button', { name: '隐藏 PDF 目录', exact: true }).click();
  await expect(sheet(1)).toHaveAttribute('aria-busy', 'false');

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
    page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}').position, `reading:${id}`);
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
  // The page is repainted in the theme: its paper corner takes the dark page colour.
  const corner = () =>
    sheet(31)
      .locator('canvas')
      .evaluate((canvas: HTMLCanvasElement) => [
        ...canvas.getContext('2d')!.getImageData(2, 2, 1, 1).data.slice(0, 3),
      ]);
  expect(Math.min(...(await corner()))).toBeGreaterThan(200);
  await selectTheme(page, 'dark');
  await expect(pageNumber).toHaveValue('31');
  await expect.poll(async () => Math.max(...(await corner()))).toBeLessThan(60);
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
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  await nav(page, '最近访问');
  const reading = () =>
    page.request.get(`/api/nodes/${id}/reading`).then((response) => response.json());
  await expect.poll(async () => (await reading()).position.page).toBe(31);
  await expect.poll(async () => (await reading()).position.pageRatio).toBeGreaterThan(0.3);
  const other = await context.newPage();
  other.on('pageerror', (error) => errors.push(error.message));
  await other.goto(url);
  await expect(other.getByRole('spinbutton', { name: 'PDF 页码' })).toHaveValue('31');
  await expect(other.locator('.pdf-page[data-page="31"]')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(async () => Math.abs((await offset(other)) - beforeZoom)).toBeLessThan(0.04);
  await other.getByRole('spinbutton', { name: 'PDF 页码' }).fill('999');
  await other.getByRole('spinbutton', { name: 'PDF 页码' }).press('Enter');
  await expect(other.getByRole('spinbutton', { name: 'PDF 页码' })).toHaveValue('40');
  await expect(other.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
  await other.close();
  expect(errors).toEqual([]);
});

test('PDF outline toggles without losing position and navigates nested and named bookmarks', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  const headers = { origin: new URL(page.url()).origin };
  const bytes = pdfFixture(8, true, false, true);
  const uploaded = await page.request.post(`/api/files?name=chapters.pdf&size=${bytes.length}`, {
    headers,
    data: bytes,
  });
  expect(uploaded.ok()).toBe(true);
  const created = await page.request.post('/api/nodes', {
    headers,
    data: { title: '章节阅读', kind: 'pdf', fileId: (await uploaded.json()).id },
  });
  expect(created.ok()).toBe(true);
  const id = (await created.json()).id;
  await page.goto(`/n/${id}`);
  const viewer = page.getByRole('region', { name: 'PDF 阅读器', exact: true });
  const toggle = viewer.getByRole('button', { name: 'PDF 目录', exact: true });
  const toc = viewer.getByRole('navigation', { name: 'PDF 目录', exact: true });
  const number = viewer.getByRole('spinbutton', { name: 'PDF 页码', exact: true });
  const area = viewer.getByLabel('PDF 阅读区', { exact: true });
  const sheet = (page: number) => viewer.locator(`.pdf-page[data-page="${page}"]`);
  await expect(sheet(1)).toHaveAttribute('aria-busy', 'false');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toc).toHaveCount(0);
  await number.fill('4');
  await number.press('Enter');
  await expect(sheet(4)).toHaveAttribute('aria-busy', 'false');
  await area.evaluate((element) => {
    const page = element.querySelector<HTMLElement>('.pdf-page[data-page="4"]')!;
    element.scrollTop += page.clientHeight * 0.3;
  });
  const position = () =>
    page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}').position, `reading:${id}`);
  await expect.poll(async () => (await position())?.pageRatio).toBeGreaterThan(0.25);
  const before = await position();
  const beforeBox = (await area.boundingBox())!;
  const width = beforeBox.width;
  await toggle.click();
  await expect(toc.getByRole('button', { name: '2.1 Results', exact: true })).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(number).toHaveValue('4');
  expect((await position()).pageRatio).toBeCloseTo(before.pageRatio, 2);
  const panelBox = (await viewer.getByLabel('PDF 目录面板', { exact: true }).boundingBox())!;
  const viewerBox = (await viewer.boundingBox())!;
  expect(panelBox.x + panelBox.width).toBeCloseTo(viewerBox.x + viewerBox.width, 0);
  expect((await area.boundingBox())!.x).toBe(beforeBox.x);
  if (info.project.name === 'mobile') {
    await expect(area).toHaveAttribute('inert', '');
    expect((await area.boundingBox())!.width).toBe(width);
  } else {
    expect((await area.boundingBox())!.width).toBeLessThan(width - 200);
    expect(panelBox.x).toBeGreaterThanOrEqual(beforeBox.x + (await area.boundingBox())!.width);
  }
  await toc.getByRole('button', { name: '收起 2 Methods', exact: true }).click();
  await expect(toc.getByRole('button', { name: '2.1 Results', exact: true })).toBeHidden();
  await toc.getByRole('button', { name: '展开 2 Methods', exact: true }).click();
  await toc.getByRole('button', { name: '2 Methods', exact: true }).click();
  await expect(number).toHaveValue('3');
  await expect(sheet(3)).toHaveAttribute('aria-busy', 'false');
  await expect.poll(async () => (await position()).pageRatio).toBeCloseTo(380 / 640, 2);
  if (info.project.name === 'mobile') {
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
  } else {
    await expect(toc.getByRole('button', { name: '2 Methods', exact: true })).toHaveAttribute(
      'aria-current',
      'location',
    );
  }
  await page.screenshot({ path: `test-results/pdf-outline-${info.project.name}.png` });
  await toc.getByRole('button', { name: '2.1 Results', exact: true }).click();
  await expect(number).toHaveValue('5');
  await expect(sheet(5)).toHaveAttribute('aria-busy', 'false');
  await expect.poll(async () => (await position()).pageRatio).toBeCloseTo(0.25, 2);
  if (info.project.name === 'mobile') await toggle.click();
  await toc.getByRole('button', { name: 'Unresolved chapter', exact: true }).click();
  await expect(toc.getByRole('alert')).toContainText('无法定位');
  await expect(number).toHaveValue('5');
  if (info.project.name === 'mobile')
    await viewer
      .getByRole('button', { name: '收起 PDF 目录', exact: true })
      .click({ position: { x: 16, y: 20 } });
  else await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toc).toBeHidden();
  await expect(number).toHaveValue('5');
  expect((await position()).pageRatio).toBeCloseTo(0.25, 2);
  await toggle.click();
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
  await page.reload();
  await expect(number).toHaveValue('5');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(errors).toEqual([]);
});
