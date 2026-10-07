import { expect, test, type Page } from './fixtures';
import { preparePassword } from '../shared/password';

const headers = { origin: 'http://127.0.0.1:8799' };
async function login(page: Page) {
  const status = await (await page.request.get('/api/auth/status')).json();
  const result = await page.request.post(`/api/auth/${status.initialized ? 'login' : 'setup'}`, {
    headers,
    data: {
      password: await preparePassword('Note2026', status.initialized ? status.password : undefined),
      ...(!status.initialized ? { token: 'e2e-test-only-setup-token-never-deploy-0001' } : {}),
    },
  });
  expect(result.ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.locator('.app-shell')).toBeVisible();
}

async function tab(page: Page, name: string, mobile: boolean) {
  await page
    .locator(mobile ? '.phone-bottom-nav' : '.main-nav')
    .getByRole('button', { name, exact: true })
    .click();
}

test('family navigation, setting routes and all palettes remain usable on narrow and wide screens', async ({
  page,
}, info) => {
  await login(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const mobile = info.project.name === 'mobile';
  await expect(page.locator('.phone-bottom-nav')).toHaveCount(1);
  if (mobile) await expect(page.getByRole('navigation', { name: '底部导航' })).toBeVisible();
  else await expect(page.getByRole('navigation', { name: '底部导航' })).toBeHidden();
  await tab(page, '收藏', mobile);
  await expect(page).toHaveURL(/\/favorites$/);
  await tab(page, '设置', mobile);
  await expect(page).toHaveURL(/\/settings$/);
  await page.screenshot({ path: `test-results/family-settings-${info.project.name}.png` });
  for (const [label, slug] of [
    ['外观', 'theme'],
    ['阅读', 'reading'],
    ['青藜', 'ai'],
    ['离线缓存', 'offline'],
    ['分享保存', 'share'],
    ['备份与恢复', 'backup'],
    ['存储空间', 'storage'],
    ['密码与设备', 'account'],
    ['关于页间', 'about'],
  ]) {
    await page.locator('.settings-entry').getByText(label, { exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/settings/${slug}$`));
    await expect(page.locator('.phone-bottom-nav')).toHaveCount(0);
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await expect(page).toHaveURL(/\/settings$/);
  }
  await page.getByRole('button', { name: '外观', exact: true }).click();
  for (const [label, palette] of [
    ['白天', 'light'],
    ['夜间', 'dark'],
    ['星空', 'starry'],
  ]) {
    await page.getByRole('radio', { name: label, exact: true }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', palette);
    await page.screenshot({
      path: `test-results/family-theme-${palette}-${info.project.name}.png`,
    });
  }
  await page.reload();
  await expect(page).toHaveURL(/\/settings\/theme$/);
  await expect(page.getByRole('radio', { name: '星空', exact: true })).toBeChecked();
  await page.getByRole('radio', { name: '白天', exact: true }).check();
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--canvas')
          .trim()
          .toLowerCase(),
      ),
    )
    .toBe('#f9efe2');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/favorites$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/settings$/);
  await tab(page, mobile ? '笔记' : '全部笔记', mobile);
  await expect(page.locator('.library-home .loading')).toHaveCount(0);
  await page.screenshot({ path: `test-results/family-home-${info.project.name}.png` });
  if (mobile) {
    await page.setViewportSize({ width: 320, height: 640 });
    const boxes = await page
      .locator('.phone-bottom-nav button')
      .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
    expect(boxes.every((height) => height >= 48)).toBeTruthy();
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
  expect(errors).toEqual([]);
});

test('back restores the originating list and cancelled edits preserve browser history', async ({
  page,
}, info) => {
  await login(page);
  const node = await (
    await page.request.post('/api/nodes', {
      headers,
      data: {
        kind: 'markdown',
        title: `返回测试 ${info.project.name}`,
      },
    })
  ).json();
  await page.request.put(`/api/nodes/${node.id}/favorite`, { headers, data: { enabled: true } });
  await tab(page, '收藏', info.project.name === 'mobile');
  await page.locator('.node-list-main').filter({ hasText: node.title }).click();
  await expect(page).toHaveURL(new RegExp(`/n/${node.id}$`));
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await page.getByRole('button', { name: '开始编辑', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown 源码' }).fill('# 保留这份草稿');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '还有未保存的修改' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(new RegExp(`/n/${node.id}$`));
  await expect(page.getByRole('textbox', { name: 'Markdown 源码' })).toContainText('保留这份草稿');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect(page).toHaveURL(/\/favorites$/);
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/n/${node.id}$`));
  await expect(page.locator('.read-content')).toContainText('保留这份草稿');
  await page.screenshot({ path: `test-results/family-reading-${info.project.name}.png` });
  if (info.project.name === 'mobile') {
    await page.getByRole('button', { name: '打开青藜', exact: true }).click();
    const panel = page.getByRole('complementary', { name: '青藜', exact: true });
    // A half-height sheet over the page; its handle makes it full screen.
    await expect(panel).toHaveClass(/assistant-sheet/);
    await expect(panel).not.toHaveClass(/assistant-maximized/);
    const half = (await panel.boundingBox())!;
    expect(half.width).toBe(page.viewportSize()!.width);
    expect(half.y).toBeGreaterThan(page.viewportSize()!.height * 0.4);
    await page.screenshot({ path: 'test-results/family-chat-sheet-mobile.png' });
    await panel.getByRole('button', { name: '青藜全屏', exact: true }).click();
    await expect(panel).toHaveClass(/assistant-maximized/);
    await expect
      .poll(async () => (await panel.boundingBox())!.height)
      .toBe(page.viewportSize()!.height);
    await page.screenshot({ path: 'test-results/family-chat-mobile.png' });
    const back = () =>
      page.evaluate(() =>
        window.dispatchEvent(new CustomEvent('note:native-back', { cancelable: true })),
      );
    // Back first returns to half height, then closes.
    await back();
    await expect(panel).not.toHaveClass(/assistant-maximized/);
    await expect(panel).toBeVisible();
    await back();
    await expect(panel).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/n/${node.id}$`));
  }
});

test('Qingli thinking dots animate and respect reduced motion', async ({ page }, info) => {
  await login(page);
  const node = await (
    await page.request.post('/api/nodes', {
      headers,
      data: { kind: 'markdown', title: '阅读问题' },
    })
  ).json();
  await page.route(`**/api/nodes/${node.id}/assistant*`, (route) =>
    route.fulfill({
      json: {
        busy: true,
        nextBefore: null,
        messages: [
          {
            id: 'question',
            sequence: 1,
            role: 'user',
            status: 'completed',
            content: '这一段的重点是什么？',
            createdAt: Date.now(),
          },
          {
            id: 'answer',
            sequence: 2,
            role: 'assistant',
            status: 'pending',
            content: '',
            createdAt: Date.now(),
          },
        ],
      },
    }),
  );
  await page.goto(`/n/${node.id}`);
  await page.getByRole('button', { name: '打开青藜', exact: true }).click();
  const dots = page.getByRole('status', { name: '正在思考', exact: true });
  await expect(dots).toBeVisible();
  await expect(dots.locator('span')).toHaveCount(3);
  await expect(dots.locator('span').first()).toHaveCSS('animation-name', 'thinking-dot');
  await page.screenshot({ path: `test-results/family-thinking-${info.project.name}.png` });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(dots.locator('span').first()).toHaveCSS('animation-name', 'none');
});
