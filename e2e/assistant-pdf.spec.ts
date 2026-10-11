import { expect, test } from './fixtures';
import { login, assistantSeed } from './notebook-helpers';
import { assistantFixture, cropInBrowser } from './assistant-fixtures';
import { pdfFixture } from './pdf-fixtures';

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
  await page.getByRole('button', { name: '打开青藜', exact: true }).click();
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
  await dialog.getByRole('combobox', { name: 'PDF 处理方式', exact: true }).selectOption('images');
  await dialog.getByRole('button', { name: '处理所选页面' }).click();
  await expect(dialog.getByRole('alert')).toContainText('最多 6 页');
  await dialog.getByLabel('页码范围').fill('1,4');
  await dialog.getByRole('button', { name: '处理所选页面' }).click();
  await expect(dialog.getByAltText('第 4 页预览')).toBeVisible();
  await page.screenshot({ path: `test-results/pdf-file-preview-${info.project.name}.png` });
  expect(fixture.sent).toHaveLength(0);
  await dialog.getByRole('button', { name: '附到对话' }).click();
  await page.getByRole('textbox', { name: '发给青藜的问题' }).fill('解释这些页面，并注明页码。');
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
  await page.getByRole('button', { name: '打开青藜', exact: true }).click();
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
  await page.getByRole('textbox', { name: '发给青藜的问题' }).fill('概括扫描件。');
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
  const text = page.locator('.pdf-text-layer span').filter({ hasText: 'A quiet page - 1' }).first();
  await expect(text).toBeAttached();
  await text.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  await page.getByRole('button', { name: '打开青藜', exact: true }).click();
  await page.getByRole('button', { name: '引用选中文字', exact: true }).click();
  await expect(page.locator('.context-quote')).toContainText('A quiet page - 1');
  // On phones the quote focuses the question, and typing fills the screen.
  if (info.project.name === 'desktop')
    await page.getByRole('button', { name: '最大化青藜', exact: true }).click();
  await cropInBrowser(page, info.project.name === 'mobile');
  await expect(page.locator('.assistant-panel[aria-label="青藜"]')).toHaveClass(
    info.project.name === 'desktop' ? /assistant-maximized/ : /assistant-sheet/,
  );
  await page.getByRole('textbox', { name: '发给青藜的问题' }).fill('解释这一页。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.chat-assistant')).toContainText('结构要点');
  expect(fixture.sent[0].quote).toBe('A quiet page - 1');
  await page.getByRole('button', { name: '保存为子笔记', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开子笔记', exact: true })).toBeVisible();
  const saved = fixture.threads.get(node.id)!.messages[1].exportedNodeId!;
  expect((await (await page.request.get(`/api/nodes/${saved}`)).json()).parent_id).toBe(node.id);
  await page.getByRole('button', { name: '关闭青藜', exact: true }).click();
  await expect(page.locator('.pdf-scroll')).toBeVisible();
  await expect(page.locator('iframe,embed,object')).toHaveCount(0);
  await page.screenshot({ path: `test-results/pdf-assistant-${info.project.name}.png` });
});
