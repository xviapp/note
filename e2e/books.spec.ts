import { expect, test } from './fixtures';
import { noteAction } from './note-actions';
import { preparePassword } from '../shared/password';

// A 2×2 PNG: enough for the browser to decode, shrink and re-encode as JPEG.
const photo = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
  'base64',
);

test('a new book adds photographed pages that open discussions', async ({
  page,
  baseURL,
}) => {
  const headers = { origin: new URL(baseURL!).origin };
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
  // Recognition is a paid call; save the page as the server would with a fixed text.
  const recognized: { fileId: string; page?: number }[] = [];
  await page.route('**/api/nodes/*/pages', async (route) => {
    const data = route.request().postDataJSON();
    recognized.push(data);
    const title = `第 ${data.page} 页`;
    const created = await page.request.post('/api/nodes', {
      headers,
      data: {
        kind: 'markdown',
        parentId: bookId,
        title,
        content: `![${title}](/api/files/${data.fileId})\n\n认知革命发生在大约七万年前。`,
      },
    });
    await route.fulfill({ status: 201, json: await created.json() });
  });
  await page.route('**/api/nodes/*/assistant', (route) =>
    route.fulfill({ json: { messages: [], busy: false, nextBefore: null } }),
  );

  await page.goto('/');
  await page.getByRole('button', { name: '新建', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新建笔记' });
  await form.getByText('书籍', { exact: true }).click();
  await form.getByLabel('标题').fill('人类简史');
  await form.getByLabel('作者').fill('赫拉利');
  await form.getByLabel('总页数').fill('400');
  await form.getByLabel('青藜角色').fill('你是一位耐心的历史老师。');
  await form.getByRole('button', { name: '创建' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('人类简史');
  await expect(page.locator('.document-kind')).toHaveText('书籍');
  const bookId = new URL(page.url()).pathname.split('/').pop()!;
  const card = page.getByRole('region', { name: '书籍资料' });
  await expect(card).toContainText('在读');
  await expect(card).toContainText('0/400 页');
  await expect(card).toContainText('你是一位耐心的历史老师。');

  await card.locator('input[type=file]').setInputFiles({
    name: 'page.png',
    mimeType: 'image/png',
    buffer: photo,
  });
  const dialog = page.getByRole('dialog', { name: '识别 1 张书页' });
  await dialog.getByLabel('页码').fill('12');
  await dialog.getByRole('button', { name: '开始识别' }).click();
  await expect(page.locator('.children-section').getByText('第 12 页')).toBeVisible();
  expect(recognized).toHaveLength(1);
  expect(recognized[0].page).toBe(12);
  const uploaded = await page.request.get(`/api/files/${recognized[0].fileId}`);
  expect(uploaded.headers()['content-type']).toContain('image/jpeg');

  await page.locator('.children-section').getByText('第 12 页').click();
  await expect(page.locator('.read-content')).toContainText('认知革命发生在大约七万年前。');
  await noteAction(page, '新建讨论');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('讨论：第 12 页');
  await expect(page.locator('.read-content')).toContainText('围绕 第 12 页 的讨论。');
  await expect(page.getByRole('complementary', { name: '青藜' })).toBeVisible();
});
