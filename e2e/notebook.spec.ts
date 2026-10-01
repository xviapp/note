import { expect, test, type Page } from '@playwright/test';

const password = 'test-only-long-notebook-password';
const token = 'e2e-test-only-setup-token-never-deploy-0001';
async function login(page: Page) {
  const status = await (await page.request.get('/api/auth/status')).json();
  await page.goto(status.initialized ? '/' : `/#setup=${token}`);
  if (!status.initialized) {
    await page.getByLabel('设置密码', { exact: true }).fill(password);
    await page.getByLabel('确认密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '创建私人笔记库' }).click();
  } else {
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '打开笔记库' }).click();
  }
  await expect(page.getByRole('button', { name: '只读模式' })).toBeVisible();
}
async function createNote(page: Page, title: string) {
  await page.getByRole('button', { name: '新建', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '进入全库编辑模式？' });
  if (await confirm.isVisible()) await confirm.getByRole('button', { name: '确认进入' }).click();
  const form = page.getByRole('dialog', { name: '新建节点' });
  await form.getByLabel('标题', { exact: true }).fill(title);
  await form.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
}
async function edit(page: Page) {
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const global = page.getByRole('dialog', { name: '进入全库编辑模式？' });
  if (await global.isVisible()) await global.getByRole('button', { name: '确认进入' }).click();
  await page
    .getByRole('dialog', { name: '编辑这篇笔记？' })
    .getByRole('button', { name: '开始编辑' })
    .click();
  await expect(page.getByRole('textbox', { name: 'Markdown 源码' })).toBeVisible();
}
async function nav(page: Page, name: string) {
  const drawer = page.getByRole('button', { name: '打开笔记目录' });
  if (await drawer.isVisible()) await drawer.click();
  await page.locator('.main-nav').getByRole('button', { name, exact: true }).click();
}

test('default preview, two edit confirmations, save/history, favorites, trash and restore', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  await createNote(page, `阅读手记 · ${info.project.name}`);
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await edit(page);
  const content =
    '# 一个安静的阅读空间\n\n把想法留在页间，让资料有迹可循。\n\n## 本周的阅读\n\n- [x] 整理手边的资料\n- [ ] 留一点时间给思考\n\n> 阅读，是与自己的一次长谈。\n\n## 一些值得记住的事\n\n| 内容 | 状态 |\n| --- | --- |\n| 随手笔记 | 已整理 |\n| 收藏资料 | 继续读 |\n\n```js\nconst nextPage = () => keepReading();\n```\n\n## 下一页\n\n按自己的节奏，慢慢读。\n';
  await page.getByRole('textbox', { name: 'Markdown 源码' }).fill(content);
  if (info.project.name === 'mobile') {
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await expect(
      page.locator('.read-content').getByRole('heading', { name: '一个安静的阅读空间' }),
    ).toBeVisible();
    await page.getByRole('button', { name: '源码', exact: true }).click();
  }
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await expect(
    page.locator('.read-content').getByRole('heading', { name: '本周的阅读' }),
  ).toBeVisible();
  await expect(page.locator('.read-content input[type=checkbox]').first()).toBeDisabled();
  await page.getByRole('button', { name: '收藏笔记', exact: true }).click();
  const url = page.url();
  await page.reload();
  await expect(page.getByRole('button', { name: '只读模式' })).toBeVisible();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '取消收藏', exact: true })).toBeVisible();
  if (info.project.name === 'mobile') {
    await page.getByRole('button', { name: '标题目录', exact: true }).click();
    await page
      .getByRole('dialog', { name: '标题目录', exact: true })
      .getByRole('button', { name: '一些值得记住的事', exact: true })
      .click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await page.screenshot({ path: `test-results/reading-${info.project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await edit(page);
  await page.getByRole('textbox', { name: 'Markdown 源码' }).fill(`${content}\n修改后的内容。`);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '版本历史', exact: true }).click();
  const history = page.getByRole('dialog', { name: '版本历史', exact: true });
  await history.getByRole('button', { name: /版本 2/ }).click();
  await history.getByRole('button', { name: '恢复此版本', exact: true }).click();
  await page
    .getByRole('dialog', { name: '恢复这个版本？' })
    .getByRole('button', { name: '确认并恢复' })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.read-content')).not.toContainText('修改后的内容。');
  await nav(page, '收藏');
  await expect(
    page.locator('.node-list').getByText(`阅读手记 · ${info.project.name}`, { exact: true }),
  ).toBeVisible();
  await page.goto(url);
  await page.getByRole('button', { name: '只读模式' }).click();
  await page
    .getByRole('dialog', { name: '进入全库编辑模式？' })
    .getByRole('button', { name: '确认进入' })
    .click();
  await page
    .locator('.note-actions')
    .getByRole('button', { name: `管理 阅读手记 · ${info.project.name}` })
    .click();
  await page
    .locator('.note-actions')
    .getByRole('button', { name: '移到回收站', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: '移到回收站？' })
    .getByRole('button', { name: '移到回收站', exact: true })
    .click();
  await nav(page, '回收站');
  await page
    .locator('.trash-row')
    .filter({ hasText: `阅读手记 · ${info.project.name}` })
    .getByRole('button', { name: '恢复', exact: true })
    .click();
  await expect(
    page.locator('.trash-row').filter({ hasText: `阅读手记 · ${info.project.name}` }),
  ).toHaveCount(0);
  await nav(page, '收藏');
  await page
    .locator('.node-list')
    .getByText(`阅读手记 · ${info.project.name}`, { exact: true })
    .click();
  await expect(
    page.locator('.read-content').getByRole('heading', { name: '本周的阅读' }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('unsaved edits stay intact when navigation is canceled; new tabs remain read only', async ({
  page,
  context,
}, info) => {
  await login(page);
  await createNote(page, `草稿保护 · ${info.project.name}`);
  await edit(page);
  await page.getByRole('textbox', { name: 'Markdown 源码' }).fill('这是一份尚未保存的草稿。');
  await nav(page, '收藏');
  await page
    .getByRole('dialog', { name: '还有未保存的修改' })
    .getByRole('button', { name: '继续编辑', exact: true })
    .click();
  if (
    info.project.name === 'mobile' &&
    (await page.getByRole('button', { name: '关闭侧栏' }).isVisible())
  )
    await page.getByRole('button', { name: '关闭侧栏' }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown 源码' })).toContainText(
    '尚未保存的草稿',
  );
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(other.getByRole('button', { name: '只读模式' })).toBeVisible();
  await expect(other.locator('.cm-editor')).toHaveCount(0);
  await other.close();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
});

function pdfFixture() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 450 640] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 450 640] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...[1, 2].map((page) => {
      const stream = `BT /F1 24 Tf 45 550 Td (A quiet page - ${page}) Tj ET`;
      return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    }),
  ];
  let data = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(data));
    data += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(data);
  data += `xref\n0 8\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(data);
}

test('PDF and image attachments, shared file nodes and PDF reading progress', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);
  await createNote(page, `附件资料 · ${info.project.name}`);
  await edit(page);
  await page
    .getByRole('textbox', { name: 'Markdown 源码' })
    .fill('# 附件资料\n\n点开附件即可阅读。');
  await page
    .getByLabel('上传附件', { exact: true })
    .setInputFiles({ name: 'reading.pdf', mimeType: 'application/pdf', buffer: pdfFixture() });
  await expect(page.getByText('上传中…')).toHaveCount(0);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('.attachment-name').filter({ hasText: 'reading.pdf' }).click();
  const pdfDialog = page.getByRole('dialog', { name: 'reading.pdf' });
  await expect(pdfDialog.locator('canvas')).toBeVisible();
  await expect(pdfDialog.locator('.pdf-page')).toHaveAttribute('aria-busy', 'false');
  await pdfDialog.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(pdfDialog.getByRole('spinbutton', { name: 'PDF 页码' })).toHaveValue('2');
  await page.screenshot({ path: `test-results/pdf-${info.project.name}.png` });
  await pdfDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '将 reading.pdf 添加到笔记树' }).click();
  await page
    .getByRole('dialog', { name: '将附件添加到笔记树' })
    .getByRole('button', { name: '创建', exact: true })
    .click();
  await expect(page.locator('.read-content canvas')).toBeVisible();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  const pdfUrl = page.url(),
    readingPath = `/api/nodes/${pdfUrl.split('/').at(-1)}/reading`;
  await nav(page, '最近访问');
  await expect
    .poll(async () => (await (await page.request.get(readingPath)).json()).position.page)
    .toBe(2);
  await page.goto(pdfUrl);
  await expect(page.getByRole('spinbutton', { name: 'PDF 页码' })).toHaveValue('2');
  // The image is a valid tiny PNG fixture; the production UI must render it,
  // open the viewer and preserve a separate immutable attachment reference.
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=',
    'base64',
  );
  await nav(page, '全部笔记');
  await createNote(page, `图片资料 · ${info.project.name}`);
  await edit(page);
  await page
    .getByLabel('上传附件', { exact: true })
    .setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: image });
  await expect(page.getByText('上传中…')).toHaveCount(0);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('.attachment-name').filter({ hasText: 'pixel.png' }).click();
  const viewer = page.getByRole('dialog', { name: 'pixel.png' });
  await expect(viewer.locator('img')).toBeVisible();
  await viewer.getByRole('button', { name: '放大图片' }).click();
  await expect(viewer.getByText('125%', { exact: true })).toBeVisible();
  await viewer.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('reading positions resume across devices and a conflicting save preserves the draft', async ({
  page,
  context,
}, info) => {
  await login(page);
  await createNote(page, `接续阅读 · ${info.project.name}`);
  await edit(page);
  const longNote = Array.from(
    { length: 20 },
    (_, i) => `## 第 ${i + 1} 节\n\n${'这一页留给慢慢阅读的自己。'.repeat(30)}\n`,
  ).join('\n');
  await page.getByRole('textbox', { name: 'Markdown 源码' }).fill(longNote);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  const url = page.url(),
    id = url.split('/').at(-1);
  if (info.project.name === 'mobile') {
    await page.getByRole('button', { name: '标题目录', exact: true }).click();
    await page
      .getByRole('dialog', { name: '标题目录', exact: true })
      .getByRole('button', { name: '第 20 节', exact: true })
      .click();
  } else {
    await page.locator('.note-scroll').focus();
    await page.keyboard.press('End');
  }
  await expect
    .poll(async () => page.locator('.note-scroll').evaluate((element) => element.scrollTop))
    .toBeGreaterThan(500);
  const headings = await page
    .locator('.read-content h2')
    .evaluateAll((elements) => elements.map((element) => element.id));
  expect(new Set(headings).size).toBe(20);
  await nav(page, '收藏');
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/nodes/${id}/reading`)).json()).position.ratio || 0,
    )
    .toBeGreaterThan(0.7);
  const other = await context.newPage();
  await other.goto(url);
  await expect(other.locator('.read-content h2')).toHaveCount(20);
  await expect
    .poll(async () => other.locator('.note-scroll').evaluate((element) => element.scrollTop))
    .toBeGreaterThan(500);
  await page.goto(url);
  await edit(page);
  await edit(other);
  await page.getByRole('textbox', { name: 'Markdown 源码' }).fill('设备一保存的正文');
  await other.getByRole('textbox', { name: 'Markdown 源码' }).fill('设备二仍然保留的草稿');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await other.getByRole('button', { name: '保存', exact: true }).click();
  await expect(other.getByRole('alert')).toContainText('已在其他页面更新');
  await expect(other.getByRole('textbox', { name: 'Markdown 源码' })).toContainText(
    '设备二仍然保留的草稿',
  );
  await other.close();
});

test('settings change password and revoke every open device', async ({ page, context }) => {
  await login(page);
  await nav(page, '设置');
  await page.getByRole('button', { name: '修改密码', exact: true }).click();
  const form = page.getByRole('dialog', { name: '修改密码', exact: true }),
    temporary = 'temporary-test-only-new-password';
  await form.getByLabel('当前密码', { exact: true }).fill(password);
  await form.getByLabel('新密码', { exact: true }).fill(temporary);
  await form.getByLabel('再次输入新密码', { exact: true }).fill(temporary);
  await form.getByRole('button', { name: '修改并重新登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开笔记库', exact: true })).toBeVisible();
  await page.getByLabel('密码', { exact: true }).fill(temporary);
  await page.getByRole('button', { name: '打开笔记库', exact: true }).click();
  await expect(page.getByRole('button', { name: '只读模式' })).toBeVisible();
  // Restore the shared test account's password before exercising logout-all.
  const response = await page.request.post('/api/auth/password', {
    headers: { origin: 'http://127.0.0.1:8799' },
    data: { currentPassword: temporary, newPassword: password },
  });
  expect(response.ok()).toBe(true);
  await login(page);
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByRole('button', { name: '只读模式' })).toBeVisible();
  await nav(page, '设置');
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
