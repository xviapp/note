import { expect, test, type Page } from './fixtures';
import { chooseNodeType } from './note-actions';
import { preparePassword } from '../shared/password';
import type { NoteDetail, NoteNode } from '../shared/types';

// A 2×2 PNG: enough for the browser to decode, shrink and re-encode as JPEG.
const photo = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
  'base64',
);
// DeepSeek is the e2e server's local stand-in (scripts/e2e-server.mjs).
async function login(page: Page, baseURL: string) {
  const headers = { origin: new URL(baseURL).origin };
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
  await page.request.put('/api/ai/settings', {
    headers,
    data: { apiKey: 'sk-e2e-placeholder-key' },
  });
}

test('book details edit the title and cover, and pages expose the book contents', async ({ page, baseURL }, info) => {
  test.setTimeout(60_000);
  await login(page, baseURL!);
  const headers = { origin: new URL(baseURL!).origin };
  const book: NoteNode = await (await page.request.post('/api/nodes', { headers, data: { kind: 'folder', title: '量子力学', book: { author: '教材作者', pageCount: 100 } } })).json();
  const pages: NoteNode[] = [];
  for (const number of [1, 2]) pages.push(await (await page.request.post(`/api/nodes/${book.id}/pages`, { headers, data: { page: number, content: `## 波函数与测量\n\n这是第 ${number} 页。` } })).json());
  await page.goto(`/n/${book.id}`);
  const card = page.getByRole('region', { name: '书籍资料' });
  await card.getByRole('button', { name: '书籍资料', exact: true }).click();
  const form = page.getByRole('dialog', { name: '书籍资料' });
  await form.getByLabel('书名', { exact: true }).fill('量子力学入门');
  await form.getByLabel('上传封面', { exact: true }).setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: photo });
  await expect(form.getByAltText('待保存的封面')).toBeVisible();
  let failed = false;
  await page.route(`**/api/nodes/${book.id}/book`, async (route) => {
    if (route.request().method() === 'PUT' && !failed) {
      failed = true;
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '暂时无法保存' }) });
    }
    await route.continue();
  });
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('暂时无法保存');
  await expect(form.getByLabel('书名', { exact: true })).toHaveValue('量子力学入门');
  for (const theme of ['light', 'dark', 'starry']) {
    await page.evaluate((value) => window.dispatchEvent(new StorageEvent('storage', { key: 'note:theme', newValue: value })), theme);
    await page.screenshot({ path: info.outputPath(`book-form-${theme}.png`) });
  }
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('量子力学入门');
  await expect(card.getByAltText('《量子力学入门》封面')).toBeVisible();
  const detail: NoteDetail = await (await page.request.get(`/api/nodes/${book.id}`)).json();
  expect(detail.book!.cover_blob_id).toBeTruthy();
  await page.reload();
  await expect(card.getByAltText('《量子力学入门》封面')).toBeVisible();
  for (const theme of ['light', 'dark', 'starry']) {
    await page.evaluate((value) => window.dispatchEvent(new StorageEvent('storage', { key: 'note:theme', newValue: value })), theme);
    await page.screenshot({ path: info.outputPath(`book-cover-${theme}.png`) });
  }
  await page.locator('.book-page-row', { hasText: '第 1 页' }).click();
  await page.getByRole('button', { name: '书内目录', exact: true }).click();
  const contents = page.getByRole('dialog', { name: '书内目录' });
  await expect(contents.getByRole('button', { name: /第 1 页/ })).toHaveAttribute('aria-current', 'page');
  for (const theme of ['light', 'dark', 'starry']) {
    await page.evaluate((value) => window.dispatchEvent(new StorageEvent('storage', { key: 'note:theme', newValue: value })), theme);
    await page.screenshot({ path: info.outputPath(`book-contents-${theme}.png`) });
  }
  await contents.getByRole('button', { name: /第 2 页/ }).click();
  await expect(page).toHaveURL(new RegExp(`/n/${pages[1].id}$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('第 2 页');
  await page.goto(`/n/${book.id}`);
  await card.getByRole('button', { name: '书籍资料', exact: true }).click();
  await form.getByRole('button', { name: '移除封面' }).click();
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(card.locator('.book-cover')).toHaveCount(0);
});

test('a photographed page is read, discussed in 青藜 and summarized into reading notes', async ({
  page,
  baseURL,
}, info) => {
  await login(page, baseURL!);
  await page.goto('/');
  await page.getByRole('button', { name: '新建', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新建笔记' });
  await chooseNodeType(form, '书籍');
  await form.getByLabel('标题').fill('人类简史');
  await form.getByLabel('作者').fill('赫拉利');
  await form.getByLabel('总页数').fill('400');
  // A preset fills the role; 青藜 can also write a guide for this book.
  await form
    .getByLabel('阅读角色预设')
    .selectOption({ label: '历史研究者 · 历史、传记与纪实作品' });
  await expect(form.getByLabel('青藜角色')).toHaveValue(/历史研究者/);
  await form.getByRole('button', { name: '让青藜生成' }).click();
  await expect(form.getByLabel('青藜角色')).toHaveValue(
    '你是一位历史研究者，陪读者看清本书的核心论点与证据。',
  );
  await form.getByRole('button', { name: '创建' }).click();
  await expect(page.locator('.document-kind')).toHaveText('书籍');

  // A book adds pages from its card, not from "新建".
  await expect(page.locator('.document-meta')).not.toContainText('新建');
  // The book's own page talks with 青藜 about the whole book.
  await expect(page.locator('.assistant-launcher:visible')).toHaveCount(1);
  const card = page.getByRole('region', { name: '书籍资料' });
  await card.getByRole('button', { name: '手动添加页面' }).click();
  const typed = page.getByRole('dialog', { name: '手动添加页面' });
  await typed.getByLabel('页码').fill('11');
  await typed.getByLabel('正文').fill('农业出现之前，人类以采集为生。');
  await typed.getByRole('button', { name: '保存页面' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('第 11 页');
  await expect(page.locator('.read-content')).toContainText('农业出现之前');
  await expect(page.locator('.document-meta')).not.toContainText('新建');
  await expect(page.locator('.assistant-launcher:visible')).toHaveCount(1);
  await page.locator('.assistant-launcher:visible').click();
  await expect(page.getByRole('complementary', { name: '青藜' })).toBeVisible();
  await expect(page.locator('.reading-with-assistant')).not.toHaveClass(/assistant-docked/);
  await page.keyboard.press('Escape');
  await expect(page.locator('.assistant-launcher:visible')).toHaveCount(1);
  await page.goBack();

  // Photograph page 12: recognized, then summarized with questions.
  await card
    .locator('input[type=file]')
    .setInputFiles({ name: 'page.png', mimeType: 'image/png', buffer: photo });
  const dialog = page.getByRole('dialog', { name: '识别 1 张书页' });
  await dialog.getByLabel('页码').fill('12');
  await dialog.getByRole('button', { name: '开始识别' }).click();
  const row = page.locator('.book-page-row', { hasText: '第 12 页' });
  await expect(row).toContainText('作者质疑农业革命让生活更好的说法。');
  await expect(card).toContainText('12/400 页');

  await row.click();
  await expect(page.locator('.read-content')).toContainText('小麦驯化了人类');
  const insights = page.getByRole('region', { name: '本页摘要与讨论' });
  await expect(insights).toContainText('作者质疑农业革命让生活更好的说法。');

  // A question starts a discussion in 青藜 and is asked at once.
  await insights.getByRole('button', { name: '为什么说农业革命是骗局？' }).click();
  const qingli = page.getByRole('complementary', { name: '青藜' });
  await expect(qingli).toContainText('为什么说农业革命是骗局？');
  await expect(qingli).toContainText('先回答：作者是说个体的生活变差了。');
  await expect(qingli).toContainText('已带上：《人类简史》');
  await expect(page.locator('.reading-with-assistant')).not.toHaveClass(/assistant-docked/);

  for (const theme of ['light', 'dark', 'starry']) {
    await page.evaluate((value) => window.dispatchEvent(new StorageEvent('storage', { key: 'note:theme', newValue: value })), theme);
    await page.screenshot({ path: info.outputPath(`book-qingli-${theme}.png`) });
  }

  // Summarize it into the page's reading note.
  await qingli.getByRole('button', { name: '整理到笔记', exact: true }).click();
  await expect(page.getByText('已追加到「第 12 页 · 读书笔记」')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(insights).toContainText('1 条回复 · 已整理到笔记');
  await expect(insights.getByRole('button', { name: /本页读书笔记/ })).toBeVisible();

  // Another question from the page's ask bar is a second discussion.
  await page.getByLabel('就这一页提问').fill('作者的证据可靠吗？');
  await page.getByRole('button', { name: '提问', exact: true }).click();
  await expect(qingli).toContainText('作者的证据可靠吗？');
  await expect(qingli).toContainText('先回答：作者是说个体的生活变差了。');
  await page.keyboard.press('Escape');
  await expect(insights).toContainText('讨论（2）');
  // Discussions stay out of the tree and lists.
  const pageId = new URL(page.url()).pathname.split('/').pop()!;
  const children = await (await page.request.get(`/api/nodes?parent=${pageId}`)).json();
  expect(children.nodes.map((node: { title: string }) => node.title)).toEqual([
    '第 12 页 · 读书笔记',
  ]);

  // The book collects the pages' reading notes.
  await page.goBack();
  await page.getByRole('button', { name: '汇总读书笔记' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('《人类简史》读书笔记');
  await expect(page.locator('.read-content')).toContainText('第 12 页');
  await expect(page.locator('.read-content')).toContainText('多数人的生活并没有变好。');
});
