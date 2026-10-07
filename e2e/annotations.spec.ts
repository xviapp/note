import { expect, test, type Locator, type Page } from './fixtures';
import { noteAction } from './note-actions';
import { preparePassword } from '../shared/password';
import { paperHtml } from '../tests/fixtures/arxiv';

const headers = { origin: 'http://127.0.0.1:8799' };
const toolbar = (page: Page) => page.getByRole('toolbar', { name: '选中文字操作' });
// A side panel on wide windows, a dialog on phones.
const annotationList = (page: Page, name: string) =>
  page.getByRole('dialog', { name }).or(page.getByRole('complementary', { name }));
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
// Selects a paragraph and waits for the toolbar, as in selection-toolbar.spec.ts.
async function selectText(page: Page, locator: Locator) {
  await expect(async () => {
    await locator.evaluate(async (element) => {
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.addRange(range);
    });
    await expect(toolbar(page)).toBeVisible({ timeout: 1000 });
  }).toPass();
}

test('highlights and notes are saved, reopened, listed in order and exported', async ({
  page,
}, info) => {
  await login(page);
  const note = await (
    await page.request.post('/api/nodes', {
      headers,
      data: {
        kind: 'markdown',
        title: `带批注 · ${info.project.name}`,
        content: '第一段需要记住。\n\n第二段值得批注。\n\n第三段普通文字。',
      },
    })
  ).json();
  await page.goto(`/n/${note.id}`);
  const paragraphs = page.locator('.read-content p');
  await expect(paragraphs.nth(2)).toHaveText('第三段普通文字。');

  // A note on the second paragraph first, then a plain highlight on the first.
  await selectText(page, paragraphs.nth(1));
  await toolbar(page).getByRole('button', { name: '批注' }).click();
  const editor = page.getByRole('dialog', { name: '添加批注' });
  await expect(editor.locator('blockquote')).toHaveText('第二段值得批注。');
  await editor.getByLabel('批注内容').fill('这是我的想法');
  await editor.getByRole('button', { name: '保存' }).click();
  await expect(editor).toBeHidden();
  await selectText(page, paragraphs.nth(0));
  await toolbar(page).getByRole('button', { name: '高亮' }).click();
  await expect(toolbar(page)).toBeHidden();

  // Both stay after a reload, and a click on the text opens its note.
  await page.reload();
  await expect(paragraphs.nth(1)).toHaveText('第二段值得批注。');
  await expect
    .poll(() => page.evaluate(() => CSS.highlights.get('annotation-yellow-note')?.size ?? 0))
    .toBe(1);
  expect(await page.evaluate(() => CSS.highlights.get('annotation-yellow')?.size ?? 0)).toBe(1);
  await paragraphs.nth(1).click({ position: { x: 24, y: 8 } });
  const saved = page.getByRole('dialog', { name: '批注', exact: true });
  await expect(saved.getByLabel('批注内容')).toHaveValue('这是我的想法');
  await saved.getByRole('button', { name: '关闭' }).click();
  await expect(saved).toBeHidden();

  // The list follows the text, and exports as a child note.
  await noteAction(page, '批注（2）');
  const list = annotationList(page, '批注（2）');
  await expect(list.locator('.annotation-item-quote')).toHaveText([
    '第一段需要记住。',
    '第二段值得批注。',
  ]);
  await list.getByRole('button', { name: '导出为子笔记' }).click();
  await expect(list.getByText(/已保存为子笔记「.*（批注）」（2 条）/)).toBeVisible();
  const children = (await (await page.request.get(`/api/nodes?parent=${note.id}`)).json()).nodes;
  const child = await (await page.request.get(`/api/nodes/${children[0].id}`)).json();
  expect(child.title).toBe(`${note.title}（批注）`);
  expect(child.content.indexOf('> 第一段需要记住。')).toBeLessThan(
    child.content.indexOf('> 第二段值得批注。\n\n这是我的想法'),
  );

  // Deleting from the editor removes the highlight.
  await list.getByRole('button', { name: '编辑批注' }).first().click();
  await page
    .getByRole('dialog', { name: '批注', exact: true })
    .getByRole('button', { name: '删除' })
    .click();
  await expect
    .poll(() => page.evaluate(() => CSS.highlights.get('annotation-yellow')?.size ?? 0))
    .toBe(0);
  const remaining = (await (await page.request.get(`/api/nodes/${note.id}/annotations`)).json())
    .annotations;
  expect(remaining.map((item: { note: string }) => item.note)).toEqual(['这是我的想法']);
});

// Three pages with one line of text each, as in translation.spec.ts.
function pdfFixture() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (let page = 1; page <= 3; page++) {
    const stream = `BT /F1 18 Tf 40 250 Td (Marked PDF page ${page}) Tj ET`;
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

test('PDF selections are highlighted on their page and open their note', async ({ page }) => {
  await login(page);
  const pdf = pdfFixture();
  const file = await (
    await page.request.post(`/api/files?name=marked.pdf&size=${pdf.length}`, {
      headers,
      data: Buffer.from(pdf),
    })
  ).json();
  const node = await (
    await page.request.post('/api/nodes', {
      headers,
      data: { kind: 'pdf', title: 'PDF 批注', fileId: file.id },
    })
  ).json();
  await page.goto(`/n/${node.id}`);
  const pageInput = page.getByRole('spinbutton', { name: 'PDF 页码' });
  await pageInput.fill('2');
  await pageInput.press('Enter');
  await selectText(
    page,
    page.locator('.pdf-text-layer span').filter({ hasText: 'Marked PDF page 2' }),
  );
  await toolbar(page).getByRole('button', { name: '批注' }).click();
  const editor = page.getByRole('dialog', { name: '添加批注' });
  await editor.getByLabel('批注内容').fill('第二页的要点');
  await editor.getByRole('button', { name: '保存' }).click();
  await expect(editor).toBeHidden();

  await page.reload();
  await pageInput.fill('2');
  await pageInput.press('Enter');
  const mark = page.locator('.pdf-page[data-page="2"] .pdf-annotation.has-note').first();
  await expect(mark).toBeInViewport();
  const box = (await mark.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const saved = page.getByRole('dialog', { name: '批注', exact: true });
  await expect(saved.getByLabel('批注内容')).toHaveValue('第二页的要点');
  await saved.getByRole('button', { name: '关闭' }).click();

  // From the list, the PDF returns to the page; the export names it.
  await pageInput.fill('1');
  await pageInput.press('Enter');
  await noteAction(page, '批注（1）');
  const list = annotationList(page, '批注（1）');
  await list.getByRole('button', { name: '导出为子笔记' }).click();
  await expect(list.getByText(/（1 条）/)).toBeVisible();
  await list.locator('.annotation-item').click();
  await expect(pageInput).toHaveValue('2');
  const children = (await (await page.request.get(`/api/nodes?parent=${node.id}`)).json()).nodes;
  const child = await (await page.request.get(`/api/nodes/${children[0].id}`)).json();
  expect(child.content).toContain('第 2 页\n\n> Marked PDF page 2\n\n第二页的要点');
});

const highlights = (page: Page, name: string) =>
  page.evaluate((key) => CSS.highlights.get(key)?.size ?? 0, name);
async function create(page: Page, data: object) {
  const response = await page.request.post('/api/nodes', { headers, data });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
const textLocation = (exact: string, start: number) => ({
  kind: 'text',
  start,
  end: start + exact.length,
  exact,
  prefix: '',
  suffix: '',
});

test('colours: picked in the note, remembered for highlights, filtered in the list', async ({
  page,
}, info) => {
  await login(page);
  const note = await create(page, {
    kind: 'markdown',
    title: `彩色批注 · ${info.project.name}`,
    content: '第一段文字。\n\n第二段文字。\n\n第三段文字。',
  });
  await page.goto(`/n/${note.id}`);
  const paragraphs = page.locator('.read-content p');
  await selectText(page, paragraphs.nth(0));
  await toolbar(page).getByRole('button', { name: '批注' }).click();
  const editor = page.getByRole('dialog', { name: '添加批注' });
  await editor.getByRole('radio', { name: '蓝色' }).click();
  await editor.getByLabel('批注内容').fill('蓝色想法');
  await editor.getByRole('button', { name: '保存' }).click();
  await expect.poll(() => highlights(page, 'annotation-blue-note')).toBe(1);
  // A plain highlight takes the colour last picked.
  await selectText(page, paragraphs.nth(1));
  await toolbar(page).getByRole('button', { name: '高亮' }).click();
  await expect.poll(() => highlights(page, 'annotation-blue')).toBe(1);
  await paragraphs.nth(1).click({ position: { x: 24, y: 8 } });
  const saved = page.getByRole('dialog', { name: '批注', exact: true });
  await saved.getByRole('radio', { name: '粉色' }).click();
  await saved.getByRole('button', { name: '保存' }).click();
  await expect.poll(() => highlights(page, 'annotation-pink')).toBe(1);

  await noteAction(page, '批注（2）');
  const list = annotationList(page, '批注（2）');
  await expect(list.locator('.annotation-item')).toHaveCount(2);
  await list.getByRole('button', { name: '只看粉色' }).click();
  await expect(list.locator('.annotation-item-quote')).toHaveText(['第二段文字。']);
  await list.getByRole('button', { name: '全部' }).click();
  await expect(list.locator('.annotation-item')).toHaveCount(2);
});

test('search finds a note by its annotation and opens it there', async ({ page }, info) => {
  await login(page);
  const filler = Array.from({ length: 40 }, (_, i) => `填充段落 ${i + 1}。`).join('\n\n');
  const content = `${filler}\n\n深处的关键句子。`;
  const note = await create(page, {
    kind: 'markdown',
    title: `搜索批注 · ${info.project.name}`,
    content,
  });
  const quote = '深处的关键句子。';
  const response = await page.request.put(`/api/nodes/${note.id}/annotations/s1`, {
    headers,
    data: {
      quote,
      note: `独特标记${info.project.name}`,
      location: textLocation(quote, content.replace(/\n\n/g, '').indexOf(quote)),
    },
  });
  expect(response.ok()).toBeTruthy();
  await page.goto('/');
  await page.keyboard.press('Control+k');
  const search = page.getByRole('dialog', { name: '搜索笔记' });
  if (!(await search.isVisible())) await page.getByRole('button', { name: /搜索/ }).first().click();
  await search.getByRole('combobox').fill(`独特标记${info.project.name}`);
  const option = search.getByRole('option').filter({ hasText: note.title });
  await expect(option.locator('.search-annotation')).toContainText(quote);
  await option.click();
  await expect(page).toHaveURL(new RegExp(note.id));
  // The page scrolls to the quote and marks it.
  await expect.poll(() => highlights(page, 'translation-source')).toBe(1);
  await expect(page.locator('.read-content p').last()).toBeInViewport();
});

test('Qingli receives the file notes when asked to', async ({ page }) => {
  await login(page);
  await page.request.put('/api/ai/settings', {
    headers,
    data: { apiKey: 'sk-e2e-placeholder-key' },
  });
  const posts: Record<string, unknown>[] = [];
  await page.route('**/api/nodes/*/assistant', async (route) => {
    if (route.request().method() === 'POST') {
      posts.push(route.request().postDataJSON());
      return route.fulfill({ status: 503, json: { error: '测试中不调用模型。' } });
    }
    await route.fulfill({ json: { nextBefore: null, busy: false, messages: [] } });
  });
  const note = await create(page, { kind: 'text', title: '附上批注', content: '一句话。' });
  await page.request.put(`/api/nodes/${note.id}/annotations/q1`, {
    headers,
    data: { quote: '一句话。', note: '想问的', location: textLocation('一句话。', 0) },
  });
  await page.goto(`/n/${note.id}`);
  await page.getByRole('button', { name: '打开青藜', exact: true }).click();
  const qingli = page.getByRole('complementary', { name: '青藜', exact: true });
  await qingli.getByRole('button', { name: '附上我的批注' }).click();
  await expect(qingli.locator('.context-quote')).toContainText('1 条高亮与批注');
  await qingli.getByRole('textbox', { name: '发给青藜的问题' }).fill('总结我的批注');
  await qingli.getByRole('button', { name: /^发送/ }).click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({ content: '总结我的批注', annotations: true });
});

test('the comparison view shows and adds notes on the source side', async ({ page }, info) => {
  await login(page);
  const paper = await create(page, {
    kind: 'link',
    title: `对照批注 · ${info.project.name}`,
    url: 'https://arxiv.org/html/2503.01800v1',
  });
  await page.route(`**/api/nodes/${paper.id}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const detail = await (await route.fetch()).json();
    await route.fulfill({
      json: {
        ...detail,
        arxiv_id: '2503.01800v1',
        variant: 'paper',
        content: paperHtml,
        attachments: [],
      },
    });
  });
  await page.route(`**/api/nodes/${paper.id}/paper-translation**`, (route) =>
    route.fulfill({ json: { language: 'zh-CN', blocks: {}, glossary: null, updatedAt: null } }),
  );
  await page.goto(`/n/${paper.id}`);
  const first = page
    .locator('.read-content p')
    .filter({ hasText: 'Reading a mathematical paper.' });
  await selectText(page, first);
  await toolbar(page).getByRole('button', { name: '高亮' }).click();
  await expect.poll(() => highlights(page, 'annotation-yellow')).toBe(1);
  await page
    .locator('.note-actions')
    .getByRole('button', { name: '对照阅读', exact: true })
    .click();
  const view = page.getByRole('dialog', { name: `对照阅读：${paper.title}` });
  if (info.project.name === 'mobile')
    await view.getByRole('button', { name: '原文', exact: true }).click();
  const source = view.getByRole('region', { name: '原文' });
  // The page and the view each paint their own copy.
  await expect.poll(() => highlights(page, 'annotation-yellow')).toBe(2);
  const second = source.locator('p').filter({ hasText: /^Equation 1 and Reference 1/ });
  await selectText(page, second);
  await view
    .getByRole('toolbar', { name: '选中文字操作' })
    .getByRole('button', { name: '批注' })
    .click();
  const editor = page.getByRole('dialog', { name: '添加批注' });
  await editor.getByLabel('批注内容').fill('对照时写的');
  await editor.getByRole('button', { name: '保存' }).click();
  await expect(editor).toBeHidden();
  await expect(view).toBeVisible();
  await expect.poll(() => highlights(page, 'annotation-yellow-note')).toBe(2);
  await view.getByRole('button', { name: '关闭对照阅读' }).click();
  await noteAction(page, '批注（2）');
  await expect(annotationList(page, '批注（2）')).toContainText('对照时写的');
});

test('each side of the split view has its own notes', async ({ page }, info) => {
  await login(page);
  const left = await create(page, {
    kind: 'markdown',
    title: `分屏左 · ${info.project.name}`,
    content: '左边的正文。',
  });
  const right = await create(page, {
    kind: 'markdown',
    title: `分屏右 · ${info.project.name}`,
    content: '右边要划线的句子。',
  });
  await page.request.put(`/api/nodes/${left.id}/annotations/l1`, {
    headers,
    data: { quote: '左边的正文。', note: '', location: textLocation('左边的正文。', 0) },
  });
  await page.goto(`/n/${left.id}`);
  const menu = page.locator('.note-actions .node-menu');
  await menu.getByRole('button', { name: `管理 ${left.title}`, exact: true }).click();
  await menu.getByRole('button', { name: '分屏查看', exact: true }).click();
  const view = page.getByRole('dialog', { name: '分屏查看' });
  await view.locator('.split-picker .node-list-main').filter({ hasText: right.title }).click();
  const paragraph = view.getByRole('region', { name: right.title }).getByText('右边要划线的句子。');
  await selectText(page, paragraph);
  await view
    .getByRole('toolbar', { name: '选中文字操作' })
    .getByRole('button', { name: '高亮' })
    .click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/nodes/${right.id}/annotations`)).json()).annotations
          .length,
    )
    .toBe(1);
  // Left (from the page and the split) and right are painted.
  await expect.poll(() => highlights(page, 'annotation-yellow')).toBe(3);
  const leftNotes = await (await page.request.get(`/api/nodes/${left.id}/annotations`)).json();
  expect(leftNotes.annotations).toHaveLength(1);
});

test('notes are marked in the margin; the list stays open beside the text on wide screens', async ({
  page,
}, info) => {
  await login(page);
  const filler = Array.from({ length: 30 }, (_, i) => `铺垫段落 ${i + 1}。`).join('\n\n');
  const content = `开头有想法的一句。\n\n${filler}\n\n结尾有想法的一句。`;
  const note = await create(page, {
    kind: 'markdown',
    title: `边注 · ${info.project.name}`,
    content,
  });
  const plain = content.replace(/\n\n/g, '');
  for (const [id, quote, text] of [
    ['m1', '开头有想法的一句。', '开头的想法'],
    ['m2', '结尾有想法的一句。', '结尾的想法'],
  ])
    await page.request.put(`/api/nodes/${note.id}/annotations/${id}`, {
      headers,
      data: { quote, note: text, location: textLocation(quote, plain.indexOf(quote)) },
    });
  await page.goto(`/n/${note.id}`);
  const markers = page.locator('.annotation-marker');
  await expect(markers).toHaveCount(2);
  // A mark sits on the line of its quote and opens its note.
  const first = page.locator('.read-content p').first();
  const [line, mark] = [(await first.boundingBox())!, (await markers.first().boundingBox())!];
  expect(Math.abs(line.y + line.height / 2 - (mark.y + mark.height / 2))).toBeLessThan(6);
  await markers.first().click();
  const editor = page.getByRole('dialog', { name: '批注', exact: true });
  await expect(editor.getByLabel('批注内容')).toHaveValue('开头的想法');
  await editor.getByRole('button', { name: '关闭' }).click();

  await noteAction(page, '批注（2）');
  const list = annotationList(page, '批注（2）');
  await list.getByRole('button', { name: /结尾有想法的一句/ }).click();
  await expect(page.locator('.read-content p').last()).toBeInViewport();
  if (info.project.name === 'desktop') {
    // Still open, the item just opened marked; the next one is one click away.
    await expect(list).toBeVisible();
    await expect(list.locator('[aria-current="location"]')).toContainText('结尾有想法');
    await list.getByRole('button', { name: /开头有想法的一句/ }).click();
    await expect(first).toBeInViewport();
    await page.getByRole('button', { name: '关闭批注面板' }).click();
    await expect(list).toBeHidden();
  } else await expect(list).toBeHidden();
});
