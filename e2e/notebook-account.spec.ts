import { expect, test } from './fixtures';
import { password, expectPreview, login, nav } from './notebook-helpers';
import { preparePassword } from '../shared/password';

test('settings change password and revoke every open device', async ({ page, context }) => {
  await login(page);
  await nav(page, '设置', '密码与设备');
  await page.getByRole('button', { name: '修改密码', exact: true }).click();
  const form = page.getByRole('dialog', { name: '修改密码', exact: true }),
    temporary = 'Next2026';
  await expect(form.getByLabel('新密码', { exact: true })).toHaveAttribute('minlength', '8');
  await form.getByLabel('当前密码', { exact: true }).fill(password);
  await form.getByLabel('新密码', { exact: true }).fill(temporary);
  await form.getByLabel('再次输入新密码', { exact: true }).fill(temporary);
  await form.getByRole('button', { name: '修改并重新登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开笔记库', exact: true })).toBeVisible();
  await page.getByLabel('密码', { exact: true }).fill(temporary);
  await page.getByRole('button', { name: '打开笔记库', exact: true }).click();
  await expectPreview(page);
  // Restore the shared test account's password before exercising logout-all.
  const status = await (await page.request.get('/api/auth/status')).json();
  const response = await page.request.post('/api/auth/password', {
    headers: { origin: 'http://127.0.0.1:8799' },
    data: {
      currentPassword: await preparePassword(temporary, status.password),
      newPassword: await preparePassword(password),
    },
  });
  expect(response.ok()).toBe(true);
  await login(page);
  const other = await context.newPage();
  await other.goto('/');
  await expectPreview(other);
  await nav(page, '设置', '密码与设备');
  await page.getByRole('button', { name: '退出所有设备', exact: true }).click();
  await page
    .getByRole('dialog', { name: '退出所有设备？' })
    .getByRole('button', { name: '退出所有设备', exact: true })
    .click();
  await expect(page.getByRole('button', { name: '打开笔记库', exact: true })).toBeVisible();
  await other.reload();
  await expect(other.getByRole('button', { name: '打开笔记库', exact: true })).toBeVisible();
  await other.close();
});
