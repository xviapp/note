import { expect, test, type Locator, type Page } from './fixtures';
import { preparePassword } from '../shared/password';
import { paperHtml } from '../tests/fixtures/arxiv';

const headers = { origin: 'http://127.0.0.1:8799' };
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
// A long article, so both sides scroll; every paragraph has a different length.
const paragraphs = Array.from(
  { length: 40 },
  (_, i) =>
    `<div class="ltx_para"><p class="ltx_p">Paragraph ${i + 1} explains ${'the method in more detail '.repeat(1 + (i % 5) * 3)}with <math alttext="x_${i}"><mi>x</mi></math>.</p></div>`,
).join('');
const content = paperHtml.replace('</article>', `${paragraphs}</article>`);

// The first paragraph reaching the top of a pane.
const topBlock = (pane: Locator) =>
  pane.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const block = Array.from(element.querySelectorAll<HTMLElement>('[data-block]')).find(
      (item) => item.getBoundingClientRect().bottom > top + 1,
    );
    return Number(block?.dataset.block);
  });

// The Worker suite covers saving and the model call; here the server is
// modelled: each paragraph becomes "译文：<source>", and a drawn-up glossary
// maps "method" to "方法".
async function modelServer(page: Page, id: string, delay = 0) {
  const saved: Record<string, string> = {};
  const batches: { hash: string; text: string }[][] = [];
  const refreshed: boolean[] = [];
  const glossaryTexts: string[] = [];
  let glossary: { source: string; target: string }[] | null = null;
  const reply = (blocks: Record<string, string>) => ({
    language: 'zh-CN',
    blocks,
    glossary,
    updatedAt: Date.now(),
  });
  await page.route(`**/api/nodes/${id}/paper-translation**`, async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.method() === 'GET') return route.fulfill({ json: reply(saved) });
    const body = request.postDataJSON();
    if (url.pathname.endsWith('/glossary')) {
      if (request.method() === 'POST') {
        glossaryTexts.push(body.text);
        glossary ??= [{ source: 'method', target: '方法' }];
      } else glossary = body.terms;
      return route.fulfill({ json: reply({}) });
    }
    batches.push(body.blocks);
    refreshed.push(!!body.refresh);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    for (const block of body.blocks)
      saved[block.hash] = `译文${body.refresh ? '（新）' : ''}：${block.text}`;
    await route.fulfill({
      json: reply(
        Object.fromEntries(body.blocks.map((b: { hash: string }) => [b.hash, saved[b.hash]])),
      ),
    });
  });
  return { saved, batches, refreshed, glossaryTexts };
}
async function openPaper(page: Page, title: string, html: string) {
  const paper = await (
    await page.request.post('/api/nodes', {
      headers,
      data: { kind: 'link', title, url: 'https://arxiv.org/html/2503.01800v1' },
    })
  ).json();
  await page.route(`**/api/nodes/${paper.id}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const detail = await (await route.fetch()).json();
    await route.fulfill({
      json: { ...detail, arxiv_id: '2503.01800v1', content: html, attachments: [] },
    });
  });
  return paper;
}

test('a paper translates paragraph by paragraph and both sides scroll together', async ({
  page,
}, info) => {
  await login(page);
  const paper = await openPaper(page, `对照论文 · ${info.project.name}`, content);
  const { batches } = await modelServer(page, paper.id);
  await page.goto(`/n/${paper.id}`);
  await page
    .locator('.note-actions')
    .getByRole('button', { name: '对照阅读', exact: true })
    .click();
  const view = page.getByRole('dialog', { name: `对照阅读：${paper.title}` });
  await expect(view).toBeVisible();
  const progress = view.locator('.compare-progress');
  await expect(progress).toContainText('已翻译 0/');
  await view.getByRole('button', { name: '翻译全文' }).click();
  await expect(progress).toContainText('已全部翻译');
  // A full run saves the translation as a Markdown child note of the paper.
  await expect(view.getByText(/已保存为子笔记/)).toBeVisible();
  const children = (await (await page.request.get(`/api/nodes?parent=${paper.id}`)).json()).nodes;
  expect(children.map((child: { title: string }) => child.title)).toEqual([
    `${paper.title}（简体中文译文）`,
  ]);
  const child = await (await page.request.get(`/api/nodes/${children[0].id}`)).json();
  expect(child.content).toContain('译文：Paragraph 3 explains');
  expect(child.content).toMatch(/with \$x_2\$\./);
  // Saving again updates that note as a new version instead of adding another.
  await view.getByRole('button', { name: '保存为子笔记' }).click();
  await expect(view.getByText(/已更新子笔记/)).toBeVisible();
  expect(
    (await (await page.request.get(`/api/nodes?parent=${paper.id}`)).json()).nodes,
  ).toHaveLength(1);
  // Paragraphs were sent in several batches, with formulas held back as ⟦n⟧.
  expect(batches.length).toBeGreaterThan(1);
  const sent = batches.flat().find((block) => block.text.startsWith('Paragraph 3 '))!;
  expect(sent.text).toMatch(/with ⟦0⟧\.$/);
  const target = view.getByRole('region', { name: '译文' });
  const third = target.locator('[data-block]').filter({ hasText: /^译文：Paragraph 3 explains/ });
  await expect(third.locator('math')).toHaveCount(1);
  await expect(target.locator('.is-pending')).toHaveCount(0);

  const source = view.getByRole('region', { name: '原文' });
  if (info.project.name === 'desktop') {
    await source.hover();
    await page.mouse.wheel(0, 2400);
    await expect.poll(() => topBlock(source)).toBeGreaterThan(5);
    await expect.poll(async () => (await topBlock(target)) === (await topBlock(source))).toBe(true);
    await target.hover();
    await page.mouse.wheel(0, 1600);
    await expect.poll(async () => (await topBlock(source)) === (await topBlock(target))).toBe(true);
  } else {
    // One side at a time on phones; switching keeps the paragraph.
    await expect(source).toBeHidden();
    await target.evaluate((element) => element.scrollBy(0, 2400));
    const reading = await topBlock(target);
    expect(reading).toBeGreaterThan(5);
    await view.getByRole('button', { name: '原文', exact: true }).click();
    await expect(source).toBeVisible();
    await expect.poll(() => topBlock(source)).toBe(reading);
    await view.getByRole('button', { name: '译文', exact: true }).click();
  }

  // A single paragraph can be translated again.
  await third.scrollIntoViewIfNeeded();
  await third.click();
  await view.getByRole('button', { name: '重译这一段' }).click();
  await expect.poll(() => batches.length).toBeGreaterThan(2);
  expect(batches.at(-1)!.map((block) => block.text)).toEqual([sent.text]);
  await page.keyboard.press('Escape');
  await expect(view).toHaveCount(0);
});

// Four sections of five paragraphs; two paragraphs of section 3 use "method".
const sectioned = `<article class="ltx_document"><h1 class="ltx_title ltx_title_document">Sections</h1>${Array.from(
  { length: 4 },
  (_, s) =>
    `<section class="ltx_section" id="S${s + 1}"><h2 class="ltx_title ltx_title_section">Part ${s + 1} heading</h2>${Array.from(
      { length: 4 },
      (_, p) =>
        `<div class="ltx_para"><p class="ltx_p">Section ${s + 1} paragraph ${p + 1} ${s === 2 && p < 2 ? 'describes the method' : 'reports results'} ${'with careful words '.repeat(6)}.</p></div>`,
    ).join('')}</section>`,
).join('')}</article>`;

test('only the current section can be translated, and glossary edits redo only affected paragraphs', async ({
  page,
}, info) => {
  await login(page);
  const paper = await openPaper(page, `分节论文 · ${info.project.name}`, sectioned);
  const { batches, refreshed, glossaryTexts } = await modelServer(page, paper.id);
  await page.goto(`/n/${paper.id}`);
  await page
    .locator('.note-actions')
    .getByRole('button', { name: '对照阅读', exact: true })
    .click();
  const view = page.getByRole('dialog', { name: `对照阅读：${paper.title}` });
  const target = view.getByRole('region', { name: '译文' });
  await expect(view.locator('.compare-progress')).toContainText('已翻译 0/20');
  await target.evaluate((pane) => {
    const heading = Array.from(pane.querySelectorAll('h2')).find((h) =>
      h.textContent?.includes('Part 3'),
    )!;
    pane.scrollTop += heading.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  });
  await view.getByRole('button', { name: '只翻译本节（5 段）' }).click();
  await expect(view.locator('.compare-progress')).toContainText('已翻译 5/20');
  expect(batches.flat().every((block) => /^(Part 3 heading|Section 3 )/.test(block.text))).toBe(
    true,
  );
  // The glossary was drawn from the title and headings first, once.
  expect(glossaryTexts).toHaveLength(1);
  expect(glossaryTexts[0]).toContain('Part 4 heading');

  await view.getByRole('button', { name: '术语表', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '术语表', exact: true });
  await expect(dialog.getByRole('textbox', { name: '术语 1' })).toHaveValue('method');
  await dialog.getByRole('textbox', { name: '译名 1' }).fill('途径');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  const prompt = page.getByRole('dialog', { name: '术语表已保存' });
  await expect(prompt).toContainText('2 段');
  await prompt.getByRole('button', { name: '重新翻译 2 段' }).click();
  await expect.poll(() => refreshed.at(-1)).toBe(true);
  expect(batches.at(-1)!.map((block) => block.text.slice(0, 31))).toEqual([
    'Section 3 paragraph 1 describes',
    'Section 3 paragraph 2 describes',
  ]);
  await expect(target.getByText(/^译文（新）：Section 3 paragraph 1/)).toBeVisible();

  // The outline names translated headings and moves both sides to a section.
  await view.getByRole('button', { name: '目录', exact: true }).click();
  const outline = view.getByRole('navigation', { name: '目录' });
  await expect(outline.getByRole('button', { name: '译文：Part 3 heading' })).toBeVisible();
  await outline.getByRole('button', { name: 'Part 4 heading' }).click();
  const top = (pane: typeof target) =>
    pane.evaluate((element) => {
      const edge = element.getBoundingClientRect().top + 8;
      const heading = Array.from(element.querySelectorAll('h2')).find(
        (h) => h.getBoundingClientRect().bottom > edge,
      );
      return heading?.textContent;
    });
  await expect.poll(() => top(target)).toContain('Part 4');
  if (info.project.name === 'desktop') {
    await expect.poll(() => top(view.getByRole('region', { name: '原文' }))).toContain('Part 4');
    await expect(outline.getByRole('button', { name: 'Part 4 heading' })).toHaveAttribute(
      'aria-current',
      'location',
    );
  } else await expect(outline).toHaveCount(0);
});

test('a translation keeps running after the view closes, and the view reopens where it was', async ({
  page,
}, info) => {
  await login(page);
  const paper = await openPaper(page, `后台翻译 · ${info.project.name}`, content);
  const { saved } = await modelServer(page, paper.id, 1500);
  await page.goto(`/n/${paper.id}`);
  const compare = page
    .locator('.note-actions')
    .getByRole('button', { name: '对照阅读', exact: true });
  await compare.click();
  const view = page.getByRole('dialog', { name: `对照阅读：${paper.title}` });
  // Without the switch, finishing does not add a child note.
  await view.getByRole('checkbox', { name: '翻完存为子笔记' }).uncheck();
  // Escape in the glossary closes only the glossary.
  await view.getByRole('button', { name: '术语表', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '术语表', exact: true })).toHaveCount(0);
  await expect(view).toBeVisible();

  // Close at once, with the first batches still in flight (each takes 1.5 s).
  await view.getByRole('button', { name: '翻译全文' }).click();
  await view.getByRole('button', { name: '关闭对照阅读' }).click();
  await expect(view).toHaveCount(0);
  // Progress shows on the toolbar, and a notice says when it is done.
  await expect(compare.locator('.toolbar-progress')).toHaveText(/%$/);
  await expect(page.getByRole('status').filter({ hasText: '全文翻译完成' })).toBeVisible();
  await expect(compare.locator('.toolbar-progress')).toHaveCount(0);
  expect(Object.keys(saved).length).toBeGreaterThan(0);
  expect((await (await page.request.get(`/api/nodes?parent=${paper.id}`)).json()).nodes).toEqual(
    [],
  );

  // Reopening returns to the paragraph last read.
  await compare.click();
  await expect(view.locator('.compare-progress')).toContainText('已全部翻译');
  const pane = view.getByRole('region', { name: info.project.name === 'mobile' ? '译文' : '原文' });
  await pane.evaluate((element) => {
    const block = element.querySelector<HTMLElement>('[data-block="20"]')!;
    element.scrollTop += block.getBoundingClientRect().top - element.getBoundingClientRect().top;
  });
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await expect(view).toHaveCount(0);
  await compare.click();
  await expect
    .poll(() =>
      pane.evaluate((element) => {
        const top = element.getBoundingClientRect().top + 1;
        const block = Array.from(element.querySelectorAll<HTMLElement>('[data-block]')).find(
          (item) => item.getBoundingClientRect().bottom > top,
        );
        return Number(block?.dataset.block);
      }),
    )
    .toBe(20);
});

test('Qingli opens inside the comparison view, with selected text quoted', async ({
  page,
}, info) => {
  await login(page);
  await page.request.put('/api/ai/settings', {
    headers,
    data: { apiKey: 'sk-e2e-placeholder-key' },
  });
  const paper = await openPaper(page, `对照问青藜 · ${info.project.name}`, content);
  await modelServer(page, paper.id);
  await page.route('**/api/nodes/*/assistant', (route) =>
    route.fulfill({ json: { nextBefore: null, busy: false, messages: [] } }),
  );
  await page.goto(`/n/${paper.id}`);
  await page
    .locator('.note-actions')
    .getByRole('button', { name: '对照阅读', exact: true })
    .click();
  const view = page.getByRole('dialog', { name: `对照阅读：${paper.title}` });
  const target = view.getByRole('region', { name: '译文' });
  const paragraph = target.locator('[data-block]').filter({ hasText: /^Paragraph 2 explains/ });
  await paragraph.scrollIntoViewIfNeeded();
  await paragraph.click();
  await paragraph.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  const toolbar = view.getByRole('toolbar', { name: '选中文字操作' });
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole('button', { name: '问青藜', exact: true }).click();
  // The view stays open; Qingli shows inside it with the quote.
  await expect(view).toBeVisible();
  const qingli = view.getByRole('complementary', { name: '青藜', exact: true });
  await expect(qingli).toBeVisible();
  await expect(qingli.locator('.context-quote')).toContainText('Paragraph 2 explains');
  await qingli.getByRole('button', { name: '关闭青藜', exact: true }).click();
  await expect(qingli).toBeHidden();
  // The launcher is reachable inside the view too.
  await view.getByRole('button', { name: '打开青藜', exact: true }).click();
  await expect(qingli).toBeVisible();
  if (info.project.name === 'mobile') {
    // On phones Qingli covers the screen; closing it returns to the view.
    await qingli.getByRole('button', { name: '关闭青藜', exact: true }).click();
    await view.getByRole('button', { name: '关闭对照阅读' }).click();
    await expect(view).toHaveCount(0);
    await expect(page.getByRole('button', { name: '打开青藜', exact: true })).toBeVisible();
  } else {
    // Closing the view puts Qingli back on the page, still open.
    await view.getByRole('button', { name: '关闭对照阅读' }).click();
    await expect(view).toHaveCount(0);
    await expect(page.getByRole('complementary', { name: '青藜', exact: true })).toBeVisible();
  }
});

test('the translation opens in a window of its own and scrolls with the source', async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name === 'mobile', 'Phones show one side at a time instead.');
  await login(page);
  const paper = await (
    await page.request.post('/api/nodes', {
      headers,
      data: {
        kind: 'link',
        title: `双屏论文 · ${info.project.name}`,
        url: 'https://arxiv.org/html/2503.01800v1',
      },
    })
  ).json();
  // Routed for every window of the context, the new one included.
  await context.route(`**/api/nodes/${paper.id}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const detail = await (await route.fetch()).json();
    await route.fulfill({
      json: { ...detail, arxiv_id: '2503.01800v1', content, attachments: [] },
    });
  });
  await context.route(`**/api/nodes/${paper.id}/paper-translation**`, (route) =>
    route.fulfill({ json: { language: 'zh-CN', blocks: {}, glossary: null, updatedAt: null } }),
  );
  await page.goto(`/n/${paper.id}`);
  await page
    .locator('.note-actions')
    .getByRole('button', { name: '对照阅读', exact: true })
    .click();
  const view = page.getByRole('dialog', { name: `对照阅读：${paper.title}` });
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    view.getByRole('button', { name: '译文放到另一屏' }).click(),
  ]);
  const other = popup.getByRole('dialog', { name: `译文：${paper.title}` });
  await expect(other).toBeVisible();
  await expect(other.getByRole('status')).toContainText('与原文窗口联动');
  await expect(view.getByText('译文在另一个窗口中')).toBeVisible();
  const source = view.getByRole('region', { name: '原文' }),
    target = other.getByRole('region', { name: '译文' });
  await expect(view.getByRole('region', { name: '译文' })).toBeHidden();
  await expect(other.getByRole('region', { name: '原文' })).toBeHidden();

  // Either window leads; the other keeps the same paragraph at the top.
  await source.evaluate((pane) => {
    pane.querySelector('[data-block="30"]')!.scrollIntoView({ block: 'start' });
  });
  await expect.poll(() => topBlock(target)).toBe(30);
  await target.evaluate((pane) => {
    pane.querySelector('[data-block="12"]')!.scrollIntoView({ block: 'start' });
  });
  await expect.poll(() => topBlock(source)).toBe(12);

  // A paragraph clicked here flashes there.
  await source.locator('[data-block="13"]').click();
  await expect(target.locator('[data-block="13"]')).toHaveClass(/is-flash/);

  // Taking the translation back closes its window and shows both sides again.
  await Promise.all([
    popup.waitForEvent('close'),
    view.getByRole('button', { name: '收回译文' }).click(),
  ]);
  await expect(view.getByRole('region', { name: '译文' })).toBeVisible();
});
