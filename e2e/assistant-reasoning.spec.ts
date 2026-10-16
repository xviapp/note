import { test, expect } from './fixtures';
import { login, assistantSeed } from './notebook-helpers';

test('reasoning opens on demand, survives reloads and stays out of exported notes', async ({ page }, info) => {
  await login(page);
  const headers = { origin: 'http://127.0.0.1:8799' };
  await page.request.put('/api/ai/settings', {
    headers, data: { apiKey: 'sk-e2e-placeholder-key', thinkingLevel: 'high' },
  });
  const { node } = await assistantSeed(page, {
    kind: 'markdown', title: '思考过程', content: '作者质疑农业革命让所有人的生活都变好的说法。',
  });
  await page.goto(`/n/${node.id}`);
  await page.getByRole('button', { name: '打开青藜', exact: true }).click();
  const panel = page.getByRole('complementary', { name: '青藜', exact: true });
  await panel.getByRole('button', {
    name: info.project.name === 'mobile' ? '青藜全屏' : '最大化青藜', exact: true,
  }).click();
  await panel.getByRole('textbox', { name: '发给青藜的问题', exact: true }).fill('解释作者的观点。');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  const reply = panel.locator('.chat-assistant').first();
  await expect(reply.locator('.markdown-body')).toContainText('先回答：');
  const thinking = reply.locator('.chat-reasoning');
  const summary = thinking.locator('summary');
  const text = thinking.locator('.chat-reasoning-content');
  await expect(summary).toHaveText('查看思考过程');
  await expect(text).not.toBeVisible();
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(text).toBeVisible();
  await expect(text).toContainText('先检查提问中的条件');
  for (const theme of ['light', 'dark', 'starry']) {
    await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`assistant-reasoning-${theme}.png`) });
  }
  await summary.click();
  await expect(text).not.toBeVisible();
  await reply.getByRole('button', { name: '保存为子笔记', exact: true }).click();
  await expect(reply.getByRole('button', { name: '打开子笔记', exact: true })).toBeVisible();
  const history = await (await page.request.get(`/api/nodes/${node.id}/assistant`)).json();
  const answer = history.messages[1];
  const exported = await (await page.request.get(`/api/nodes/${answer.exportedNodeId}`)).json();
  expect(exported.content).toBe(answer.content);
  expect(exported.content).not.toContain(answer.reasoning);

  await page.reload();
  await page.getByRole('button', { name: '打开青藜', exact: true }).click();
  await expect(text).not.toBeVisible();
  await summary.click();
  await expect(text).toHaveText(answer.reasoning);
  await page.request.put('/api/ai/settings', { headers, data: { thinkingLevel: 'none' } });
  await panel.getByRole('textbox', { name: '发给青藜的问题', exact: true }).fill('继续解释。');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  const plain = panel.locator('.chat-assistant').last();
  await expect(panel.locator('.chat-assistant')).toHaveCount(2);
  await expect(plain.locator('.markdown-body')).toContainText('先回答：');
  await expect(plain.locator('.chat-reasoning')).toHaveCount(0);
});
