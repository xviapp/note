import { expect, test } from './fixtures';
import { preparePassword } from '../shared/password';

test('ink mode persists, restores themes and turns reading screens', async ({ page }, info) => {
  const headers = { origin: 'http://127.0.0.1:8799' };
  const status = await (await page.request.get('/api/auth/status')).json();
  const login = await page.request.post(`/api/auth/${status.initialized ? 'login' : 'setup'}`, {
    headers,
    data: {
      password: await preparePassword('Note2026', status.initialized ? status.password : undefined),
      ...(!status.initialized ? { token: 'e2e-test-only-setup-token-never-deploy-0001' } : {}),
    },
  });
  expect(login.ok()).toBeTruthy();
  await page.goto('/settings/theme');
  const toggle = page.getByRole('switch', { name: '墨水屏模式' });
  for (const theme of ['light', 'dark', 'starry']) {
    await page.locator(`input[name="theme"][value="${theme}"]`).check();
    await page.screenshot({ path: info.outputPath(`theme-${theme}.png`) });
    await toggle.check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('html')).toHaveAttribute('data-ink', 'true');
    expect(
      await page
        .locator('html')
        .evaluate((el) => getComputedStyle(el).getPropertyValue('--surface').trim()),
    ).toMatch(/^#(?:fff|ffffff)$/);
    await page.reload();
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  }
  await toggle.check();
  await page.screenshot({ path: info.outputPath('ink-settings.png') });
  const response = await page.request.post('/api/nodes', {
    headers,
    data: {
      kind: 'markdown',
      title: '墨水屏阅读',
      content: '# 阅读\n\n' + '落笔于页，留心于间。\n\n'.repeat(160),
    },
  });
  const note = await response.json();
  await page.goto(`/n/${note.id}`);
  await expect(page.locator('.read-content')).toBeVisible();
  await page.getByRole('button', { name: '下一屏', exact: true }).click();
  await expect
    .poll(() => page.locator('.note-scroll').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(100);
  await page.screenshot({ path: info.outputPath('ink-reading.png') });
  await page.getByRole('button', { name: '上一屏', exact: true }).click();
  await expect.poll(() => page.locator('.note-scroll').evaluate((el) => el.scrollTop)).toBe(0);
  await page.addInitScript(() => {
    Object.assign(window, { androidBridge: {} });
  });
  await page.reload();
  await expect(page.locator('.app-shell')).toBeVisible();
  if (info.project.name === 'desktop') {
    await expect(page.locator('.app-shell')).not.toHaveClass(/android-shell/);
    await page.setViewportSize({ width: 800, height: 1000 });
  }
  await expect(page.locator('.app-shell')).toHaveClass(/android-shell/);
});
