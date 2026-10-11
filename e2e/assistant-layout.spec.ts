import { expect, test } from './fixtures';
import { login, assistantSeed } from './notebook-helpers';
import { assistantFixture } from './assistant-fixtures';

test('assistant floats, docks and maximizes while keeping drafts, attachments and reading layout', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  const { node } = await assistantSeed(page, {
    kind: 'markdown',
    title: `窗口模式 · ${info.project.name}`,
    content: '# 阅读与对话\n\n保持正文宽度，边读边问。\n\n## 记录\n\n浮窗可以移到合适的位置。',
  });
  await page.request.put('/api/ai/settings', {
    headers: { origin: 'http://127.0.0.1:8799' },
    data: { apiKey: 'sk-e2e-placeholder-key' },
  });
  const fixture = await assistantFixture(page);
  await page.goto(`/n/${node.id}`);
  const workspace = page.locator('.note-workspace');
  const launcher = page.getByRole('button', { name: '打开青藜', exact: true });
  await expect(launcher).toBeVisible();
  const original = (await workspace.boundingBox())!;
  await launcher.click();
  const panel = page.getByRole('complementary', { name: '青藜', exact: true });
  const input = panel.getByRole('textbox', { name: '发给青藜的问题', exact: true });
  await expect(panel).toBeVisible();
  await expect.poll(async () => (await workspace.boundingBox())!.width).toBe(original.width);
  const floating = (await panel.boundingBox())!;
  expect(floating.height).toBeLessThan(page.viewportSize()!.height);
  // On phones it opens as a half-height sheet.
  if (info.project.name === 'mobile') expect(floating.width).toBe(page.viewportSize()!.width);
  await input.fill('切换窗口后继续这个问题。');
  await panel.getByRole('button', { name: '附上当前文件', exact: true }).click();
  const attachment = page.getByRole('dialog', { name: '附上文件', exact: true });
  await attachment.getByRole('button', { name: '附到对话', exact: true }).click();
  let position = floating;
  if (info.project.name === 'desktop') {
    const handle = panel.getByRole('group', { name: '移动青藜窗口' });
    const grip = (await handle.boundingBox())!;
    const start = { x: grip.x + 25, y: grip.y + grip.height / 2 };
    const end = { x: start.x - (info.project.name === 'mobile' ? 0 : 170), y: start.y - 90 };
    if (info.project.name === 'mobile') {
      const session = await page.context().newCDPSession(page);
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [start],
      });
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [end] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await session.detach();
    } else {
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 6 });
      await page.mouse.up();
    }
    await expect
      .poll(async () => Math.round((await panel.boundingBox())!.y))
      .toBe(Math.round(floating.y - 90));
    const moved = (await panel.boundingBox())!;
    await handle.focus();
    await page.keyboard.press('ArrowUp');
    await expect
      .poll(async () => Math.round((await panel.boundingBox())!.y))
      .toBe(Math.round(moved.y - 10));
    position = (await panel.boundingBox())!;
    await page.screenshot({ path: `test-results/assistant-floating-${info.project.name}.png` });

    await panel.getByRole('button', { name: '贴边青藜', exact: true }).click();
    const area = (await page.locator('.reading-with-assistant').boundingBox())!;
    await expect
      .poll(async () => Math.round((await panel.boundingBox())!.y))
      .toBe(Math.round(area.y));
    const docked = (await panel.boundingBox())!;
    expect(Math.round(docked.x + docked.width)).toBe(Math.round(area.x + area.width));
    expect(Math.round(docked.height)).toBe(Math.round(area.height));
    expect((await workspace.boundingBox())!.width).toBe(
      info.project.name === 'desktop' ? original.width - 400 : original.width,
    );
    await page.screenshot({ path: `test-results/assistant-docked-${info.project.name}.png` });

    await panel.getByRole('button', { name: '最大化青藜', exact: true }).click();
  } else await panel.getByRole('button', { name: '青藜全屏', exact: true }).click();
  await expect
    .poll(async () => (await panel.boundingBox())!.height)
    .toBe(page.viewportSize()!.height);
  const full = (await panel.boundingBox())!;
  expect(full.x).toBe(0);
  expect(full.y).toBe(0);
  expect(full.height).toBe(page.viewportSize()!.height);
  await expect(input).toHaveValue('切换窗口后继续这个问题。');
  await expect(panel.locator('.context-file')).toHaveCount(1);
  const send = panel.getByRole('button', { name: '发送', exact: true });
  await expect(send).toBeEnabled();
  await send.focus();
  await page.keyboard.press('Tab');
  await expect(panel.getByRole('button', { name: '全局对话', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(send).toBeFocused();
  await panel.getByRole('button', { name: '附上当前文件', exact: true }).click();
  await expect(attachment).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(attachment).toHaveCount(0);
  await expect(panel).toHaveClass(/assistant-maximized/);
  await page.screenshot({ path: `test-results/assistant-maximized-${info.project.name}.png` });
  if (info.project.name === 'desktop') {
    await panel.getByRole('button', { name: '还原青藜', exact: true }).click();
    await expect(panel.getByRole('button', { name: '悬浮青藜', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: '悬浮青藜', exact: true }).click();
    expect(await panel.boundingBox()).toEqual(position);
    await panel.getByRole('button', { name: '最大化青藜', exact: true }).click();
    await page.keyboard.press('Escape');
    expect(await panel.boundingBox()).toEqual(position);
  }

  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: 320, height: 560 });
  await expect.poll(async () => (await panel.boundingBox())!.width).toBe(320);
  const small = (await panel.boundingBox())!;
  expect(small.x).toBeGreaterThanOrEqual(0);
  expect(small.y).toBeGreaterThanOrEqual(0);
  expect(small.x + small.width).toBeLessThanOrEqual(320);
  expect(small.y + small.height).toBeLessThanOrEqual(560);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 320, height: 300 });
  await send.scrollIntoViewIfNeeded();
  await expect(send).toBeInViewport({ ratio: 1 });
  await expect(panel.getByRole('button', { name: '关闭青藜', exact: true })).toBeInViewport();
  await page.setViewportSize(viewport);
  await panel.getByRole('button', { name: '关闭青藜', exact: true }).click();
  await expect(launcher).toBeVisible();
  await expect.poll(async () => (await workspace.boundingBox())!.width).toBe(original.width);
  await launcher.click();
  await expect(input).toHaveValue('切换窗口后继续这个问题。');
  await expect(panel.locator('.context-file')).toHaveCount(1);
  await send.click();
  await expect(panel.locator('.chat-assistant')).toContainText('结构要点');
  expect(fixture.sent).toHaveLength(1);
  expect(fixture.sent[0].files).toHaveLength(1);
  if (info.project.name === 'desktop')
    await panel.getByRole('button', { name: '最大化青藜', exact: true }).click();
  await panel.getByRole('button', { name: '保存为子笔记', exact: true }).click();
  await expect(panel.getByRole('button', { name: '打开子笔记', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
