import { test, expect } from './fixtures';
import { login } from './notebook-helpers';

// 设置 → 待发送: what was saved here but has not reached the server.
test('a refused 随手记 shows in 待发送 with its reason, and can be retried or deleted', async ({ page }, info) => {
  await login(page);
  let refuse = true;
  await page.route('**/api/clips', (route) =>
    route.request().method() === 'POST' && refuse
      ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '服务器暂不接受' }) })
      : route.continue(),
  );
  await page.goto('/');
  const clips = async (text: string) => {
    await page.locator('.app-header').getByRole('button', { name: '随手记' }).click();
    const dialog = page.getByRole('dialog', { name: '随手记' });
    await dialog.getByLabel('随手记内容').fill(text);
    await dialog.getByLabel('随手记内容').press('ControlOrMeta+Enter');
    await expect(dialog.locator('.clip-item').first()).toContainText(text);
    await dialog.getByRole('button', { name: '关闭' }).first().click();
  };
  await clips('第一条：被拒绝');
  await clips('第二条：也被拒绝');

  await page.goto('/settings');
  const entry = page.getByRole('button', { name: /待发送/ });
  await expect(entry.locator('.settings-badge')).toHaveText('2');
  await entry.click();
  const group = page.getByRole('region', { name: '随手记' });
  await expect(group.getByText('第一条：被拒绝')).toBeVisible();
  await expect(group.getByText('未能发送：服务器暂不接受').first()).toBeVisible();
  await page.screenshot({ path: `test-results/outbox-${info.project.name}.png` });

  // Deleting asks first; it is only on this device.
  await group.getByRole('button', { name: '删除 第二条：也被拒绝' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
  await expect(group.getByText('第二条：也被拒绝')).toHaveCount(0);

  refuse = false;
  await group.getByRole('button', { name: '立即重试' }).click();
  await expect(page.getByText('没有待发送的内容。')).toBeVisible();
  const list = await (await page.request.get('/api/clips')).json();
  expect(list.items.map((item: { text: string }) => item.text)).toEqual(['第一条：被拒绝']);
});
