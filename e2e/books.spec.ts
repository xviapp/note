import { expect, test, type Page } from './fixtures';
import { preparePassword } from '../shared/password';

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

test('a photographed page is read, discussed in 青藜 and summarized into reading notes', async ({
  page,
  baseURL,
}) => {
  await login(page, baseURL!);
  await page.goto('/');
  await page.getByRole('button', { name: '新建', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新建笔记' });
  await form.getByText('书籍', { exact: true }).click();
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

  // Photograph page 12: recognized, then summarized with questions.
  const card = page.getByRole('region', { name: '书籍资料' });
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
