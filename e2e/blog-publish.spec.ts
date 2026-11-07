import { expect, test, type Page } from './fixtures';
import { preparePassword } from '../shared/password';
import type { NoteNode } from '../shared/types';

const BODY = `# 文章\n\n${'这是一段足够长的正文，用来确认摘要的来源。'.repeat(10)}`;

async function setUp(page: Page, baseURL: string) {
  const headers = { origin: new URL(baseURL).origin };
  const status = await (await page.request.get('/api/auth/status')).json();
  const auth = await page.request.post(status.initialized ? '/api/auth/login' : '/api/auth/setup', {
    headers,
    data: status.initialized
      ? { password: await preparePassword('Note2026', status.password) }
      : { password: await preparePassword('Note2026'), token: 'e2e-test-only-setup-token-never-deploy-0001' },
  });
  expect(auth.ok()).toBeTruthy();
  await page.request.put('/api/ai/settings', { headers, data: { apiKey: 'sk-e2e-placeholder-key' } });
  const root: NoteNode = await (await page.request.post('/api/nodes', { headers, data: { kind: 'folder', title: '博客' } })).json();
  await page.request.put('/api/blog/settings', { headers, data: { parentId: root.id, title: '我的博客' } });
  const note: NoteNode = await (
    await page.request.post('/api/nodes', {
      headers,
      data: { kind: 'markdown', title: '文章', parentId: root.id, content: BODY, attachments: [] },
    })
  ).json();
  return note;
}

test('publishing shows the generated summary, which can be edited and regenerated', async ({ page, baseURL }) => {
  const note = await setUp(page, baseURL!);
  await page.goto(`/n/${note.id}`);
  await page.getByRole('button', { name: '管理 文章', exact: true }).last().click();
  await page.getByRole('button', { name: '发布到博客…' }).click();
  const dialog = page.getByRole('dialog', { name: '发布到博客' });
  await expect(dialog.getByLabel('摘要')).toHaveCount(0);
  await dialog.getByRole('button', { name: '发布', exact: true }).click();

  const published = page.getByRole('dialog', { name: '博客文章' });
  const summary = published.getByLabel('摘要');
  await expect(published.getByText('由青藜根据已发布的版本生成')).toBeVisible();
  const generated = await summary.inputValue();
  expect(generated).not.toBe('');
  expect(generated).not.toContain('这是一段足够长的正文');

  const save = published.getByRole('button', { name: '保存摘要' });
  await expect(save).toBeDisabled();
  await summary.fill('我自己写的摘要');
  await save.click();
  await expect(published.getByText('手动填写，更新文章时会保留')).toBeVisible();
  await expect(save).toBeDisabled();

  await published.getByRole('button', { name: '重新生成' }).click();
  await expect(published.getByText('由青藜根据已发布的版本生成')).toBeVisible();
  await expect(summary).toHaveValue(generated);
});
