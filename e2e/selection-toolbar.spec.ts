import { expect, test, type Locator, type Page } from '@playwright/test';
import { openAttachments } from './note-actions';
import { preparePassword } from '../shared/password';
import { AI_QUOTE_LIMIT, type ChatHistory } from '../shared/assistant';

const paragraph = '选中这一段文字，可以加入当前文件的助手。';
const toolbar = (page: Page) => page.getByRole('toolbar', { name: '选中文字操作' });

async function prepare(page: Page, baseURL: string) {
  const origin = new URL(baseURL).origin;
  const headers = { origin };
  const status = await (await page.request.get('/api/auth/status')).json();
  const response = await page.request.post(
    status.initialized ? '/api/auth/login' : '/api/auth/setup',
    {
      headers,
      data: status.initialized
        ? { password: await preparePassword('Note2026', status.password) }
        : {
            token: 'e2e-test-only-setup-token-never-deploy-0001',
            password: await preparePassword('Note2026'),
          },
    },
  );
  expect(response.ok()).toBe(true);
  const create = async (data: object) => {
    const result = await page.request.post('/api/nodes', { headers, data });
    expect(result.ok()).toBe(true);
    return result.json();
  };
  const node = await create({
    kind: 'markdown',
    title: '划词阅读',
    content:
      `# 读到这里\n\n${paragraph}\n\n公式 $E=mc^2$。\n\n` +
      Array.from({ length: 24 }, (_, i) => `第 ${i + 1} 段阅读记录。`).join('\n\n'),
  });
  const posts: string[] = [];
  const history: ChatHistory = {
    nextBefore: null,
    busy: false,
    messages: [
      {
        id: crypto.randomUUID(),
        sequence: 1,
        role: 'assistant',
        status: 'completed',
        content: '这里是助手的一段回复，可以继续引用提问。\n\n公式 $E=mc^2$。',
        createdAt: Date.now(),
      },
    ],
  };
  await page.route('**/api/nodes/*/assistant', async (route) => {
    if (route.request().method() !== 'GET') posts.push(route.request().url());
    await route.fulfill({ json: history });
  });
  await page.goto(`/n/${node.id}`);
  await expect(page.locator('.read-content')).toContainText(paragraph);
  return { node, headers, create, posts };
}

async function selectText(page: Page, locator: Locator) {
  await locator.click();
  await locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await expect(toolbar(page)).toBeVisible();
}

async function assertInViewport(page: Page) {
  const box = await toolbar(page).boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
}

test('selection toolbar copies, offers translation, and dismisses without editing', async ({
  page,
  baseURL,
  context,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { node, posts } = await prepare(page, baseURL!);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const text = page.locator('.read-content p').first();
  if (info.project.name === 'desktop') {
    const points = await text.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const rect = range.getBoundingClientRect();
      return { left: rect.left, right: rect.right, y: (rect.top + rect.bottom) / 2 };
    });
    await page.mouse.move(points.left, points.y);
    await page.mouse.down();
    await page.mouse.move(points.right, points.y, { steps: 12 });
    await expect(toolbar(page)).toHaveCount(0);
    await page.mouse.up();
    await expect(toolbar(page)).toBeVisible();
  } else await selectText(page, text);
  await assertInViewport(page);
  await toolbar(page).getByRole('button', { name: '复制', exact: true }).click();
  await expect(toolbar(page).getByRole('status')).toHaveText('已复制');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(paragraph);
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(paragraph);
  await expect(toolbar(page).getByRole('button', { name: '翻译', exact: true })).toBeEnabled();
  expect(posts).toEqual([]);
  await assertInViewport(page);
  await page.screenshot({ path: info.outputPath('selection-light.png') });
  await page.keyboard.press('Escape');
  await expect(toolbar(page)).toHaveCount(0);
  await selectText(page, text);
  await page.keyboard.press('Tab');
  await expect(toolbar(page).getByRole('button', { name: '复制', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(toolbar(page).getByRole('button', { name: '问青藜', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(toolbar(page)).toHaveCount(0);
  await selectText(page, text);
  await page.locator('.document-heading h1').click();
  await expect(toolbar(page)).toHaveCount(0);
  await selectText(page, text);
  await page.locator('.note-scroll').evaluate((element) => {
    element.scrollTop = 150;
  });
  await expect(toolbar(page)).toHaveCount(0);
  await selectText(page, page.locator('.read-content p').nth(2));
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'starry';
  });
  await page.screenshot({ path: info.outputPath('selection-starry.png') });
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await page.getByRole('button', { name: '开始编辑', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Markdown 源码' });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await expect(toolbar(page)).toHaveCount(0);
  expect((await (await page.request.get(`/api/nodes/${node.id}`)).json()).content).toContain(
    paragraph,
  );
  expect(errors).toEqual([]);
});

test('selection quotes open the current assistant, retain a draft, and work in maximized chat', async ({
  page,
  baseURL,
}, info) => {
  const { create, posts } = await prepare(page, baseURL!);
  await selectText(page, page.locator('.read-content p').first());
  const join = toolbar(page).getByRole('button', { name: '问青藜', exact: true });
  if (info.project.name === 'mobile') await join.tap();
  else await join.click();
  const panel = page.getByRole('complementary', { name: '青藜' });
  await expect(panel).toBeVisible();
  await expect(panel.locator('.context-quote')).toContainText(paragraph);
  await expect(toolbar(page)).toHaveCount(0);
  const input = panel.getByRole('textbox', { name: '发给青藜的问题' });
  await input.fill('这个问题先留在草稿里');
  await panel.getByRole('button', { name: '关闭青藜', exact: true }).click();
  await selectText(page, page.locator('.read-content p').nth(1));
  await toolbar(page).getByRole('button', { name: '问青藜', exact: true }).click();
  await expect(panel.locator('.context-quote')).toHaveText('公式 $E=mc^2$。');
  await expect(input).toHaveValue('这个问题先留在草稿里');
  if (info.project.name === 'desktop')
    await panel.getByRole('button', { name: '最大化青藜', exact: true }).click();
  await selectText(page, panel.locator('.chat-assistant .markdown-body p').first());
  await assertInViewport(page);
  await page.screenshot({ path: info.outputPath('selection-chat.png') });
  await toolbar(page).getByRole('button', { name: '问青藜', exact: true }).click();
  await expect(panel.locator('.context-quote')).toContainText('这里是助手的一段回复');
  await expect(input).toHaveValue('这个问题先留在草稿里');
  expect(posts).toEqual([]);
  // A different file must not inherit the quote or the previous selection.
  const other = await create({ kind: 'text', title: '另一个文件', content: '另一个文件的内容。' });
  await page.goto(`/n/${other.id}`);
  await expect(toolbar(page)).toHaveCount(0);
  await page.getByRole('button', { name: '打开青藜', exact: true }).click();
  await expect(panel.locator('.context-quote')).toHaveCount(0);
  await expect(input).toHaveValue('');
});

test('PDF text and modal attachments support selection actions, including dialog dismissal', async ({
  page,
  baseURL,
}, info) => {
  const { create, headers } = await prepare(page, baseURL!);
  const stream = 'BT /F1 18 Tf 40 360 Td (Selected PDF text) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const response = await page.request.post(`/api/files?name=selection.pdf&size=${pdf.length}`, {
    headers,
    data: Buffer.from(pdf),
  });
  expect(response.ok()).toBe(true);
  const file = await response.json();
  const node = await create({ kind: 'pdf', title: 'PDF 划词', fileId: file.id });
  await page.goto(`/n/${node.id}`);
  const text = page
    .locator('.pdf-text-layer span')
    .filter({ hasText: 'Selected PDF text' })
    .first();
  await selectText(page, text);
  await assertInViewport(page);
  await page.screenshot({ path: info.outputPath('selection-pdf.png') });
  await toolbar(page).getByRole('button', { name: '问青藜', exact: true }).click();
  await expect(page.locator('.context-quote')).toContainText('Selected PDF text');
  const parent = await create({
    kind: 'markdown',
    title: '带附件的笔记',
    content: '正文',
    attachments: [file.id],
  });
  await page.goto(`/n/${parent.id}`);
  await openAttachments(page);
  await page.getByRole('button', { name: /^selection.pdf / }).click();
  const dialog = page.getByRole('dialog', { name: 'selection.pdf' });
  await selectText(page, dialog.locator('.pdf-text-layer span').first());
  await expect(dialog.getByRole('toolbar', { name: '选中文字操作' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(toolbar(page)).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await selectText(page, dialog.locator('.pdf-text-layer span').first());
  await toolbar(page).getByRole('button', { name: '问青藜', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.context-quote')).toContainText('Selected PDF text');
});

test('oversized quotes are not silently truncated or substituted for a draft', async ({
  page,
  baseURL,
}) => {
  const { create, posts } = await prepare(page, baseURL!);
  const node = await create({
    kind: 'text',
    title: '长引用',
    content: '字'.repeat(AI_QUOTE_LIMIT + 1),
  });
  await page.goto(`/n/${node.id}`);
  await selectText(page, page.locator('.plain-text'));
  await toolbar(page).getByRole('button', { name: '问青藜', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '青藜' })).toBeHidden();
  await expect(page.locator('.context-quote')).toHaveCount(0);
  await expect(toolbar(page).getByRole('status')).toContainText('请缩小选择范围');
  expect(posts).toEqual([]);
});
