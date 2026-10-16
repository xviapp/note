import { test, expect } from './fixtures';
import { login } from './notebook-helpers';

test('thinking depth saves with the key, survives reloads and resets when cleared', async ({ page }, info) => {
  await login(page);
  await page.goto('/settings/ai');
  const depth = page.getByRole('combobox', { name: '思考深度', exact: true });
  const save = page.getByRole('button', { name: '保存 AI 配置', exact: true });
  await expect(depth).toHaveValue('none');
  await expect(save).toBeDisabled();
  await page.getByLabel('DeepSeek API Key', { exact: true }).fill('sk-e2e-placeholder-key');
  await depth.selectOption('low');
  await save.click();
  await expect(page.getByRole('status')).toHaveText('AI 配置已保存。');
  await page.reload();
  await expect(depth).toHaveValue('low');
  await expect(page.getByLabel('DeepSeek API Key', { exact: true })).toBeEmpty();

  // A failed save keeps the selected depth available to retry.
  await page.route('**/api/ai/settings', async (route) => {
    if (route.request().method() === 'PUT') {
      await route.fulfill({ status: 503, json: { error: '暂时无法保存，请稍后重试。' } });
      await page.unroute('**/api/ai/settings');
    } else await route.continue();
  });
  await depth.selectOption('max');
  await save.click();
  await expect(page.getByRole('alert')).toHaveText('暂时无法保存，请稍后重试。');
  await expect(depth).toHaveValue('max');
  await save.click();
  await expect(page.getByRole('status')).toHaveText('AI 配置已保存。');
  await page.reload();
  await expect(depth).toHaveValue('max');
  expect(await (await page.request.get('/api/ai/settings')).json()).toMatchObject({
    configured: true, thinkingLevel: 'max', maxTokens: 8192,
  });

  for (const theme of ['light', 'dark', 'starry']) {
    await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
    await expect(depth).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`ai-settings-${theme}.png`), fullPage: true });
  }

  await page.getByRole('button', { name: '清除配置', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '清除配置', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('AI 配置已清除。');
  await expect(depth).toHaveValue('none');
  await expect(save).toBeDisabled();
});
