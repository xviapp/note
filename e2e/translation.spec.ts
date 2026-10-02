import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { preparePassword } from '../shared/password';
import { sourceLabel, type Translation } from '../shared/translation';

const selected = 'A conserved quantity remains unchanged during the evolution.';
const translated = '守恒量在演化过程中保持不变。\n\n公式 $E=mc^2$ 保持原样。';
const panel = (page: Page) => page.getByRole('dialog', { name: '翻译', exact: true });
const toolbar = (page: Page) => page.getByRole('toolbar', { name: '选中文字操作' });

async function select(page: Page, locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await locator.click();
  await locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await expect(toolbar(page)).toBeVisible();
}
async function launch(page: Page, locator: Locator, expanded = true) {
  await select(page, locator);
  await toolbar(page).getByRole('button', { name: '翻译', exact: true }).click();
  await expect(panel(page).locator('.markdown-body')).toBeVisible();
  if (expanded) {
    await panel(page).getByRole('button', { name: '展开翻译详情', exact: true }).click();
    await expect(panel(page).getByRole('status')).toContainText('已保存');
  }
}
async function setup(page: Page, baseURL: string) {
  const headers = { origin: new URL(baseURL).origin };
  const status = await (await page.request.get('/api/auth/status')).json();
  const auth = await page.request.post(status.initialized ? '/api/auth/login' : '/api/auth/setup', {
    headers,
    data: status.initialized
      ? { password: await preparePassword('Note2026', status.password) }
      : {
          password: await preparePassword('Note2026'),
          token: 'e2e-test-only-setup-token-never-deploy-0001',
        },
  });
  expect(auth.ok()).toBe(true);
  const create = async (data: object) => {
    const response = await page.request.post('/api/nodes', { headers, data });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const content =
    `# 原文定位\n\n${selected}\n\nThe next paragraph.\n\n` +
    Array.from({ length: 36 }, (_, i) => `Reading paragraph ${i + 1}.`).join('\n\n');
  const node = await create({ kind: 'markdown', title: '翻译与定位', content });
  const records = new Map<string, Translation & { nodeId: string }>();
  const generated: any[] = [],
    chatPosts: string[] = [];
  let failNext = false;
  await page.route('**/api/nodes/*/translations**', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const match = url.pathname.match(/\/nodes\/([^/]+)\/translations(?:\/([^/]+))?/)!;
    const [, nodeId, id] = match;
    if (request.method() === 'DELETE') {
      records.delete(id);
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (request.method() === 'GET') {
      await route.fulfill({
        json: id
          ? records.get(id)
          : {
              nextOffset: null,
              translations: Array.from(records.values())
                .filter((item) => item.nodeId === nodeId)
                .map((item) => ({
                  id: item.id,
                  excerpt: item.source.slice(0, 140),
                  targetLanguage: item.targetLanguage,
                  savedAt: item.savedAt,
                  locationLabel: sourceLabel(item.location),
                })),
            },
      });
      return;
    }
    const data = request.postDataJSON();
    const existing = Array.from(records.values()).find(
      (item) =>
        item.nodeId === nodeId &&
        item.source === data.source &&
        item.targetLanguage === data.targetLanguage,
    );
    if (existing && !data.refresh) {
      await route.fulfill({ json: { type: 'done', translation: existing, cached: true } });
      return;
    }
    generated.push(data);
    if (failNext) {
      failNext = false;
      await route.fulfill({
        contentType: 'text/event-stream',
        body: 'data: {"type":"delta","content":"不完整片段"}\n\ndata: {"type":"error","error":"译文未保存：连接中断"}\n\n',
      });
      return;
    }
    const record = {
      id: existing?.id || crypto.randomUUID(),
      nodeId,
      source: data.source,
      content: data.targetLanguage === 'en' ? 'The translated passage.' : translated,
      targetLanguage: data.targetLanguage,
      savedAt: Date.now(),
      location: data.location,
    };
    records.set(record.id, record);
    await route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ type: 'delta', content: record.content })}\n\ndata: ${JSON.stringify({ type: 'done', translation: record, cached: false })}\n\n`,
    });
  });
  await page.route('**/api/nodes/*/assistant', async (route) => {
    if (route.request().method() !== 'GET') chatPosts.push(route.request().url());
    await route.fulfill({ json: { messages: [], busy: false, nextBefore: null } });
  });
  await page.goto(`/n/${node.id}`);
  await expect(page.locator('.read-content')).toContainText(selected);
  return {
    headers,
    create,
    node,
    content,
    records,
    generated,
    chatPosts,
    fail: () => {
      failNext = true;
    },
  };
}

test('floating translations save, remember language, copy, pin, maximize, and quote without sending', async ({
  page,
  baseURL,
  context,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await setup(page, baseURL!);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await launch(page, page.locator('.read-content p').first(), false);
  await expect(page).toHaveTitle('页间');
  await expect(panel(page)).toHaveClass(/translation-compact/);
  await expect(panel(page).getByRole('button')).toHaveCount(1);
  await expect(panel(page).getByRole('combobox')).toHaveCount(0);
  await expect(
    panel(page).locator(
      '.translation-heading, .translation-original, .translation-actions, .translation-state',
    ),
  ).toHaveCount(0);
  const compact = await panel(page).boundingBox();
  expect(compact!.height).toBeLessThan(240);
  expect(compact!.x).toBeGreaterThanOrEqual(0);
  expect(compact!.y).toBeGreaterThanOrEqual(0);
  expect(compact!.x + compact!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(compact!.y + compact!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.screenshot({ path: info.outputPath('translation-compact.png') });
  await panel(page).getByRole('button', { name: '展开翻译详情', exact: true }).click();
  await expect(panel(page).locator('.markdown-body')).toContainText('守恒量');
  await expect(panel(page).locator('.katex')).toHaveCount(1);
  expect(fixture.generated[0].source).toBe(selected);
  expect(fixture.generated[0].location.kind).toBe('text');
  await panel(page).getByText('查看原文', { exact: false }).click();
  await expect(panel(page).locator('.translation-original pre')).toHaveText(selected);
  await panel(page).getByRole('button', { name: '复制', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(translated);
  const bounds = await panel(page).boundingBox(),
    viewport = page.viewportSize()!;
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
  await page.screenshot({ path: info.outputPath('translation-light.png') });
  await panel(page).getByRole('button', { name: '固定翻译窗口', exact: true }).click();
  // Stay on the toolbar's empty top padding, inside the rounded reading pane.
  await page.locator('.note-toolbar').click({ position: { x: 60, y: 4 } });
  await expect(panel(page)).toBeVisible();
  const drag = panel(page).getByRole('group', { name: '移动翻译窗口' });
  await drag.focus();
  await page.keyboard.press('ArrowDown');
  await panel(page).getByRole('button', { name: '最大化翻译窗口' }).click();
  await expect(panel(page)).toHaveClass(/translation-maximized/);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'starry';
  });
  await page.screenshot({ path: info.outputPath('translation-starry-fullscreen.png') });
  await page.keyboard.press('Escape');
  await expect(panel(page)).not.toHaveClass(/translation-maximized/);
  await panel(page).getByRole('combobox', { name: '翻译目标语言' }).selectOption('en');
  await expect(panel(page).locator('.markdown-body')).toHaveText('The translated passage.');
  await panel(page).getByRole('button', { name: '收起翻译详情' }).click();
  await expect(panel(page)).toHaveClass(/translation-compact/);
  await expect(panel(page).locator('.markdown-body')).toHaveText('The translated passage.');
  await expect(panel(page).getByRole('button', { name: '展开翻译详情' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('combobox')).toHaveValue('en');
  expect(fixture.generated).toHaveLength(2);
  await panel(page).getByRole('button', { name: '关闭翻译' }).click();
  await launch(page, page.locator('.read-content p').first());
  await expect(panel(page).getByRole('combobox')).toHaveValue('en');
  expect(fixture.generated).toHaveLength(2);
  await panel(page).getByRole('button', { name: '问青藜', exact: true }).click();
  const assistant = page.getByRole('complementary', { name: '青藜' });
  await expect(assistant.locator('.context-quote')).toContainText(selected);
  await expect(assistant.locator('.context-quote')).toContainText('The translated passage.');
  await assistant.getByRole('textbox', { name: '发给青藜的问题' }).fill('保留问题草稿');
  await assistant.getByRole('button', { name: '关闭青藜' }).click();
  await launch(page, page.locator('.read-content p').first());
  await panel(page).getByRole('button', { name: '问青藜', exact: true }).click();
  await expect(assistant.getByRole('textbox', { name: '发给青藜的问题' })).toHaveValue(
    '保留问题草稿',
  );
  expect(fixture.chatPosts).toEqual([]);
  expect((await (await page.request.get(`/api/nodes/${fixture.node.id}`)).json()).content).toBe(
    fixture.content,
  );
  expect(errors).toEqual([]);
});

test('history survives reload, retains a complete result after failure, and relocates changed Markdown', async ({
  page,
  baseURL,
}) => {
  const fixture = await setup(page, baseURL!);
  await launch(page, page.locator('.read-content p').first());
  fixture.fail();
  await panel(page).getByRole('button', { name: '重译', exact: true }).click();
  await expect(panel(page).getByRole('alert')).toContainText('未保存');
  await page.reload();
  const open = async () => {
    await page
      .locator('.note-actions')
      .getByRole('button', { name: '翻译记录', exact: true })
      .click();
    await panel(page)
      .getByRole('button', { name: new RegExp('^' + selected.slice(0, 20)) })
      .click();
    await expect(panel(page).locator('.markdown-body')).toContainText('守恒量');
  };
  await open();
  await panel(page).getByRole('button', { name: '回到原文' }).click();
  await expect(panel(page)).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      Array.from(CSS.highlights.get('translation-source') || []).map((range) => range.toString()),
    ),
  ).toEqual([selected]);
  const change = async (content: string) => {
    const unlock = await (
      await page.request.post('/api/edit/unlock', {
        headers: fixture.headers,
        data: { nodeId: fixture.node.id },
      })
    ).json();
    const detail = await (await page.request.get(`/api/nodes/${fixture.node.id}`)).json();
    expect(
      (
        await page.request.put(`/api/nodes/${fixture.node.id}/content`, {
          headers: { ...fixture.headers, 'x-note-edit': unlock.token },
          data: { revision: detail.revision, content, attachments: [] },
        })
      ).ok(),
    ).toBe(true);
    await page.reload();
  };
  await change('# 新增前言\n\n' + '前面新增一大段内容。\n\n'.repeat(36) + fixture.content);
  await open();
  await panel(page).getByRole('button', { name: '回到原文' }).click();
  await expect(page.locator('.read-content p').filter({ hasText: selected })).toBeInViewport();
  expect(
    await page.evaluate(() =>
      Array.from(CSS.highlights.get('translation-source') || []).map((range) => range.toString()),
    ),
  ).toEqual([selected]);
  await change('# 原文已经删除\n\n其他内容。');
  await open();
  await panel(page).getByRole('button', { name: '回到原文' }).click();
  await expect(panel(page).getByRole('alert')).toContainText('无法准确定位');
  await panel(page).getByRole('button', { name: '翻译记录', exact: true }).click();
  await panel(page)
    .getByRole('button', { name: /^删除翻译：/ })
    .click();
  await page
    .getByRole('dialog', { name: '删除这条翻译？' })
    .getByRole('button', { name: '删除翻译', exact: true })
    .click();
  await expect(panel(page)).toContainText('还没有翻译记录');
});

function pdfFixture() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (let page = 1; page <= 3; page++) {
    const stream = `BT /F1 18 Tf 40 250 Td (Selected PDF page ${page}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 3 0 R >> >> /Contents ${3 + page * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  }
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return pdf;
}

test('PDF source locations return to pages and highlights at another zoom, including attachments', async ({
  page,
  baseURL,
}, info) => {
  const fixture = await setup(page, baseURL!),
    pdf = pdfFixture();
  const upload = await page.request.post(`/api/files?name=translation.pdf&size=${pdf.length}`, {
    headers: fixture.headers,
    data: Buffer.from(pdf),
  });
  expect(upload.ok()).toBe(true);
  const file = await upload.json();
  const node = await fixture.create({ kind: 'pdf', title: 'PDF 翻译定位', fileId: file.id });
  await page.goto(`/n/${node.id}`);
  const pageInput = page.getByRole('spinbutton', { name: 'PDF 页码' });
  await pageInput.fill('3');
  await pageInput.press('Enter');
  await launch(
    page,
    page.locator('.pdf-text-layer span').filter({ hasText: 'Selected PDF page 3' }),
  );
  const location = fixture.generated.at(-1).location;
  expect(location).toMatchObject({ kind: 'pdf', fileId: file.id, page: 3, endPage: 3 });
  expect(location.rects.length).toBeGreaterThan(0);
  await panel(page).getByRole('button', { name: '关闭翻译' }).click();
  await pageInput.fill('1');
  await pageInput.press('Enter');
  await page.getByRole('button', { name: '放大 PDF' }).click();
  await page
    .locator('.note-actions')
    .getByRole('button', { name: '翻译记录', exact: true })
    .click();
  await panel(page)
    .getByRole('button', { name: /^Selected PDF page 3/ })
    .click();
  await panel(page).getByRole('button', { name: '回到原文' }).click();
  await expect(pageInput).toHaveValue('3');
  await expect(page.locator('.pdf-source-highlight').first()).toBeInViewport();
  await page.screenshot({ path: info.outputPath('translation-pdf-location.png') });
  const parent = await fixture.create({
    kind: 'markdown',
    title: '附件定位',
    content: '附件中的原文。',
    attachments: [file.id],
  });
  await page.goto(`/n/${parent.id}`);
  await page.getByRole('button', { name: /^translation.pdf / }).click();
  const dialog = page.getByRole('dialog', { name: 'translation.pdf', exact: true });
  await dialog.getByRole('spinbutton', { name: 'PDF 页码' }).fill('2');
  await dialog.getByRole('spinbutton', { name: 'PDF 页码' }).press('Enter');
  await launch(
    page,
    dialog.locator('.pdf-text-layer span').filter({ hasText: 'Selected PDF page 2' }),
  );
  await expect(dialog.locator('.translation-window')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload();
  await page
    .locator('.note-actions')
    .getByRole('button', { name: '翻译记录', exact: true })
    .click();
  await panel(page)
    .getByRole('button', { name: /^Selected PDF page 2/ })
    .click();
  await panel(page).getByRole('button', { name: '回到原文' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('spinbutton', { name: 'PDF 页码' })).toHaveValue('2');
  await expect(dialog.locator('.pdf-source-highlight').first()).toBeInViewport();
});

test('switching language ignores a late response; stopping and outside dismissal leave no stale result', async ({
  page,
  baseURL,
}) => {
  await setup(page, baseURL!);
  const waiting: Route[] = [];
  await page.route('**/api/nodes/*/translations', async (route) => {
    if (route.request().method() === 'POST') waiting.push(route);
    else await route.fallback();
  });
  const complete = async (route: Route, content: string) => {
    const data = route.request().postDataJSON();
    await route
      .fulfill({
        json: {
          type: 'done',
          cached: false,
          translation: {
            id: crypto.randomUUID(),
            source: data.source,
            content,
            targetLanguage: data.targetLanguage,
            location: data.location,
            savedAt: Date.now(),
          },
        },
      })
      .catch(() => {}); // A canceled network request need not accept a response.
  };
  await select(page, page.locator('.read-content p').first());
  await toolbar(page).getByRole('button', { name: '翻译', exact: true }).click();
  await expect.poll(() => waiting.length).toBe(1);
  await panel(page).getByRole('button', { name: '展开翻译详情' }).click();
  await panel(page).getByRole('combobox').selectOption('en');
  await expect.poll(() => waiting.length).toBe(2);
  await complete(waiting[1], 'Current English result.');
  await expect(panel(page).locator('.markdown-body')).toHaveText('Current English result.');
  await panel(page).getByRole('button', { name: '收起翻译详情' }).click();
  await expect(panel(page).locator('.markdown-body')).toHaveText('Current English result.');
  await panel(page).getByRole('button', { name: '展开翻译详情' }).click();
  await complete(waiting[0], '迟到的中文结果');
  await expect(panel(page).locator('.markdown-body')).toHaveText('Current English result.');
  await panel(page).getByRole('button', { name: '重译', exact: true }).click();
  await expect.poll(() => waiting.length).toBe(3);
  await panel(page).getByRole('button', { name: '停止', exact: true }).click();
  await complete(waiting[2], '停止后到达的内容');
  await expect(panel(page).getByRole('alert')).toContainText('已停止');
  await expect(panel(page).locator('.markdown-body')).toHaveCount(0);
  await page.locator('.note-toolbar').click({ position: { x: 4, y: 4 } });
  await expect(panel(page)).toHaveCount(0);
});

test('unchanged repeated Markdown uses offsets, but ambiguous matches after an edit do not jump', async ({
  page,
  baseURL,
}) => {
  const fixture = await setup(page, baseURL!);
  const block = `${'Prefix '.repeat(20)}\n\n${selected}\n\n${'Suffix '.repeat(20)}`;
  const node = await fixture.create({
    kind: 'markdown',
    title: '相同文字的定位',
    content: `${block}\n\n${block}`,
  });
  await page.goto(`/n/${node.id}`);
  await launch(page, page.locator('.read-content p').filter({ hasText: selected }).first());
  await panel(page).getByRole('button', { name: '回到原文' }).click();
  await expect(panel(page)).toHaveCount(0);
  const detail = await (await page.request.get(`/api/nodes/${node.id}`)).json();
  const unlock = await (
    await page.request.post('/api/edit/unlock', {
      headers: fixture.headers,
      data: { nodeId: node.id },
    })
  ).json();
  expect(
    (
      await page.request.put(`/api/nodes/${node.id}/content`, {
        headers: { ...fixture.headers, 'x-note-edit': unlock.token },
        data: {
          revision: detail.revision,
          content: `${detail.content}\n\nNew ending.`,
          attachments: [],
        },
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await page
    .locator('.note-actions')
    .getByRole('button', { name: '翻译记录', exact: true })
    .click();
  await panel(page)
    .getByRole('button', { name: /^A conserved quantity/ })
    .click();
  await panel(page).getByRole('button', { name: '回到原文' }).click();
  await expect(panel(page).getByRole('alert')).toContainText('无法准确定位');
  expect(await page.evaluate(() => CSS.highlights.has('translation-source'))).toBe(false);
});

test('compact translations scroll long text and expand in place without another request', async ({
  page,
  baseURL,
}, info) => {
  await setup(page, baseURL!);
  const longTranslation = `${'这是一段较长的译文，用来确认小浮窗内可以连续阅读。\n\n'.repeat(80)}译文结尾。`;
  let calls = 0;
  await page.route('**/api/nodes/*/translations', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    calls++;
    const data = route.request().postDataJSON();
    await route.fulfill({
      json: {
        type: 'done',
        cached: false,
        translation: {
          id: crypto.randomUUID(),
          source: data.source,
          content: longTranslation,
          targetLanguage: data.targetLanguage,
          location: data.location,
          savedAt: Date.now(),
        },
      },
    });
  });
  await launch(
    page,
    page.locator('.read-content p').filter({ hasText: 'Reading paragraph 4.' }),
    false,
  );
  const result = panel(page).locator('.translation-result');
  await expect
    .poll(() => result.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  const bounds = await panel(page).boundingBox();
  expect(bounds!.height).toBeLessThanOrEqual(360);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await result.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(panel(page).getByText('译文结尾。', { exact: true })).toBeInViewport();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'starry';
  });
  await page.screenshot({ path: info.outputPath('translation-compact-long.png') });
  await panel(page).getByRole('button', { name: '展开翻译详情' }).click();
  await expect(panel(page).locator('.markdown-body')).toHaveText(longTranslation);
  await panel(page).getByRole('button', { name: '最大化翻译窗口' }).click();
  await panel(page).getByRole('button', { name: '收起翻译详情' }).click();
  await expect(panel(page)).toHaveClass(/translation-compact/);
  await expect(panel(page)).not.toHaveClass(/translation-maximized/);
  expect(calls).toBe(1);
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
});
