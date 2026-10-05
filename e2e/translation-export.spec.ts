import { expect, test, type Page } from './fixtures';
import { noteAction } from './note-actions';
import { preparePassword } from '../shared/password';
import type { Translation } from '../shared/translation';

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

test('selection translations export as one child note in reading order', async ({ page }, info) => {
  await login(page);
  const note = await (
    await page.request.post('/api/nodes', {
      headers,
      data: {
        kind: 'markdown',
        title: `带翻译记录 · ${info.project.name}`,
        content: 'First sentence here.\n\nSecond sentence later.',
      },
    })
  ).json();
  // Saved records come newest first; the export puts them in text order.
  const records: Translation[] = [
    {
      id: 'later',
      source: 'Second sentence later.',
      content: '后面的第二句。',
      targetLanguage: 'zh-CN',
      savedAt: 2,
      location: {
        kind: 'text',
        start: 22,
        end: 44,
        exact: 'Second sentence later.',
        prefix: '',
        suffix: '',
      },
    },
    {
      id: 'earlier',
      source: 'First sentence here.',
      content: '这里是第一句。',
      targetLanguage: 'zh-CN',
      savedAt: 1,
      location: {
        kind: 'text',
        start: 0,
        end: 20,
        exact: 'First sentence here.',
        prefix: '',
        suffix: '',
      },
    },
  ];
  await page.route(`**/api/nodes/${note.id}/translations**`, async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.method() !== 'GET') return route.fallback();
    const id = url.pathname.split('/').at(-1);
    const record = records.find((item) => item.id === id);
    if (record) return route.fulfill({ json: record });
    await route.fulfill({
      json: {
        nextOffset: null,
        translations: records.map((item) => ({
          id: item.id,
          excerpt: item.source,
          targetLanguage: item.targetLanguage,
          savedAt: item.savedAt,
          locationLabel: '',
        })),
      },
    });
  });
  await page.goto(`/n/${note.id}`);
  await noteAction(page, '翻译记录');
  const panel = page.getByRole('dialog', { name: '翻译', exact: true });
  const history = panel.getByRole('button', { name: '翻译记录', exact: true });
  if (await history.isVisible()) await history.click();
  await panel.getByRole('button', { name: '导出翻译记录为子笔记' }).click();
  await expect(panel.getByText(/已保存为子笔记「.*（翻译记录）」（2 条）/)).toBeVisible();
  const children = (await (await page.request.get(`/api/nodes?parent=${note.id}`)).json()).nodes;
  expect(children.map((child: { title: string }) => child.title)).toEqual([
    `${note.title}（翻译记录）`,
  ]);
  const content = (await (await page.request.get(`/api/nodes/${children[0].id}`)).json()).content;
  expect(content.indexOf('> First sentence here.')).toBeGreaterThan(0);
  expect(content.indexOf('> First sentence here.')).toBeLessThan(
    content.indexOf('> Second sentence later.'),
  );
  expect(content).toContain('这里是第一句。');
});
