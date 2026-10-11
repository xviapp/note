import { expect, test } from './fixtures';
import { chooseNodeType } from './note-actions';
import { login, selectTheme } from './notebook-helpers';
import { assistantFixture, cropInBrowser } from './assistant-fixtures';
import { paperImportFixture, bluePixels } from './paper-fixtures';
import { paperHtml } from '../tests/fixtures/arxiv';
import { hostileSvg } from '../tests/fixtures/svg';

test('SVG paper diagrams remain vector images and appear in screenshots and AI attachments', async ({
  page,
}, info) => {
  await login(page);
  await page.request.put('/api/ai/settings', {
    headers: { origin: 'http://127.0.0.1:8799' },
    data: { apiKey: 'sk-e2e-placeholder-key' },
  });
  const fixture = await paperImportFixture(page, paperHtml, hostileSvg);
  const chat = await assistantFixture(page);
  const external: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('svg-tracker.invalid')) external.push(request.url());
  });
  await page.getByRole('button', { name: '新建', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新建笔记' });
  await chooseNodeType(form, 'arXiv 论文');
  await form
    .getByLabel('arXiv 论文地址', { exact: true })
    .fill('https://arxiv.org/html/2503.01800v1');
  await form.getByRole('button', { name: '导入论文', exact: true }).click();
  const diagram = page.locator('.paper-body img');
  await expect(diagram).toHaveCount(1);
  expect(fixture.paper.attachments[0].mime).toBe('image/svg+xml');
  // The element exists before its private image URL is hydrated; decode can
  // reject during that transition, so retry the complete pixel assertion.
  await expect(async () => {
    expect(await bluePixels(diagram)).toBeGreaterThan(1000);
  }).toPass({ timeout: 8000 });
  await diagram.click();
  const zoom = page.getByRole('dialog', { name: 'Paper diagram', exact: true });
  await expect(zoom).toBeVisible();
  await zoom.getByRole('button', { name: '放大图片', exact: true }).click();
  await expect(zoom.locator('.image-stage img')).toHaveCSS('transform', /matrix\(1.25/);
  expect(await bluePixels(zoom.locator('img'))).toBeGreaterThan(1000);
  await page.screenshot({ path: `test-results/svg-zoom-${info.project.name}.png` });
  await zoom.getByRole('button', { name: '关闭', exact: true }).click();
  await diagram.evaluate((image) => image.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page.getByRole('button', { name: '打开青藜', exact: true }).click();
  await page.getByRole('button', { name: '框选截图', exact: true }).click();
  const crop = page.getByRole('dialog', { name: '框选截图', exact: true });
  await expect(crop).toBeVisible();
  expect(await bluePixels(crop.getByAltText('当前阅读区截图'))).toBeGreaterThan(1000);
  await page.screenshot({ path: `test-results/svg-capture-${info.project.name}.png` });
  await crop.getByRole('button', { name: '选择整个阅读区', exact: true }).click();
  await crop.getByRole('button', { name: '采用截图', exact: true }).click();
  expect(await bluePixels(page.getByAltText('待发送截图'))).toBeGreaterThan(1000);
  await page.getByLabel('选择聊天附件', { exact: true }).setInputFiles({
    name: 'plot.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(hostileSvg),
  });
  const file = page.getByRole('dialog', { name: '附上文件', exact: true });
  await expect(file.getByAltText('文件图片预览')).toBeVisible();
  expect(await bluePixels(file.getByAltText('文件图片预览'))).toBeGreaterThan(1000);
  await file.getByRole('button', { name: '附到对话', exact: true }).click();
  await page.getByRole('textbox', { name: '发给青藜的问题' }).fill('解释 SVG 图中的曲线。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.chat-assistant')).toContainText('结构要点');
  expect(chat.sent[0].image).toMatch(/^data:image\/jpeg;base64,/);
  const attached = chat.sent[0].files![0];
  expect(attached.kind).toBe('image');
  expect(
    (await page.request.get(`/api/files/${attached.sourceId}`)).headers()['content-type'],
  ).toBe('image/svg+xml');
  expect(
    (await page.request.get(`/api/files/${attached.images[0].blobId}`)).headers()['content-type'],
  ).toBe('image/jpeg');
  expect(external).toEqual([]);
  expect(await page.evaluate(() => (window as any).svgInjected)).toBeUndefined();
});

test('imports an arXiv paper for reading, MathML, citations, saved position and its file assistant', async ({
  page,
}, info) => {
  await login(page);
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1200, height: 960 });
  await page.request.put('/api/ai/settings', {
    headers: { origin: 'http://127.0.0.1:8799' },
    data: { apiKey: 'sk-e2e-placeholder-key' },
  });
  const attacks = `<p class="app-header" style="position:fixed;inset:0" onclick="window.paperInjected=true">Untrusted styled text.</p><img src="https://paper-tracker.invalid/pixel.png" onerror="window.paperInjected=true"><a href="javascript:window.paperInjected=true">Bad link</a><math><annotation-xml encoding="text/html"><img src="x" onerror="window.paperInjected=true"></annotation-xml></math>`;
  const fixture = await paperImportFixture(
    page,
    paperHtml
      .replaceAll(
        'Paragraph to exercise the continuous reading area and position memory.',
        'Paragraph to exercise the continuous reading area and position memory. '.repeat(4),
      )
      .replace('</article>', attacks + '</article>'),
  );
  const chat = await assistantFixture(page);
  const remoteImages: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('paper-tracker.invalid')) remoteImages.push(request.url());
  });
  await page.getByRole('button', { name: '新建', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新建笔记' });
  await chooseNodeType(form, 'arXiv 论文');
  await form
    .getByLabel('arXiv 论文地址', { exact: true })
    .fill('https://arxiv.org/html/2503.01800v1');
  await form.getByRole('button', { name: '导入论文', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'A paper & its equations', exact: true }),
  ).toHaveCount(1);
  const paper = page.locator('.paper-body');
  await expect(paper.locator('math').first()).toBeVisible();
  await expect(paper).toContainText('Test Author');
  await expect(
    paper.locator('script,style,iframe,nav,form,[onclick],.app-header,annotation-xml'),
  ).toHaveCount(0);
  expect(remoteImages).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).paperInjected)).toBeUndefined();
  await expect(page.getByRole('button', { name: '编辑正文', exact: true })).toHaveCount(0);
  await expect(page.locator('.app-header')).toHaveCount(0);
  await expect(page.locator('iframe,embed,object')).toHaveCount(0);
  const href = page.url();
  await paper.getByRole('link', { name: 'Equation 1', exact: true }).click();
  await expect
    .poll(() => page.locator('.note-scroll').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(500);
  expect(page.url()).toBe(href);
  // Reading updates flush on page hide, navigation, or the 30-second timer.
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/nodes/${fixture.paper.id}/reading`)).json()).position
          .ratio || 0,
    )
    .toBeGreaterThan(0);
  const position = await page.locator('.note-scroll').evaluate((el) => el.scrollTop);
  await page.reload();
  await expect(paper.locator('math').first()).toBeAttached();
  await expect
    .poll(() => page.locator('.note-scroll').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(position * 0.8);
  const toggle = page.getByRole('button', { name: '标题目录', exact: true });
  await expect(toggle).toBeVisible();
  const toc =
    info.project.name === 'mobile'
      ? page.getByRole('dialog', { name: '标题目录', exact: true })
      : page.locator('.desktop-toc');
  if (info.project.name === 'mobile') {
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toc.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(toc).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await toggle.click();
    await page.keyboard.press('Escape');
    await expect(toc).toHaveCount(0);
    await toggle.click();
    await page.mouse.click(12, 200);
    await expect(toc).toHaveCount(0);
    await toggle.click();
  } else {
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const area = page.locator('.note-scroll');
    await toc.getByRole('button', { name: '2 Main result', exact: true }).click();
    const chapter = paper.getByRole('heading', { name: '2 Main result', exact: true });
    await expect
      .poll(async () =>
        Math.abs((await chapter.boundingBox())!.y - (await area.boundingBox())!.y - 24),
      )
      .toBeLessThan(2);
    const beforeWidth = (await area.boundingBox())!.width;
    const beforeHeight = await area.evaluate((element) => element.scrollHeight);
    const equation = paper.locator('.ltx_equation');
    const equationTop = (await equation.boundingBox())!.y;
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toc).toHaveCount(0);
    expect((await area.boundingBox())!.width).toBeGreaterThan(beforeWidth + 150);
    expect(await area.evaluate((element) => element.scrollHeight)).toBeLessThan(beforeHeight);
    expect(Math.abs((await equation.boundingBox())!.y - equationTop)).toBeLessThan(4);
    await toggle.click();
    await toc.getByRole('button', { name: '隐藏标题目录', exact: true }).click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    await toggle.click();
    await toc.getByRole('button', { name: '隐藏标题目录', exact: true }).press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
  }
  const tocBox = (await toc.boundingBox())!;
  expect(tocBox.x + tocBox.width).toBeCloseTo(page.viewportSize()!.width, 0);
  if (info.project.name === 'mobile') {
    expect(tocBox.y).toBe(0);
    expect(tocBox.height).toBe(page.viewportSize()!.height);
  }
  await page.screenshot({ path: `test-results/arxiv-outline-${info.project.name}.png` });
  await toc.getByRole('button', { name: '1 Introduction', exact: true }).click();
  if (info.project.name === 'mobile') {
    await expect(toc).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  }
  await paper.getByRole('button', { name: '放大图片：Paper diagram', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Paper diagram', exact: true })).toBeVisible();
  await page
    .getByRole('dialog', { name: 'Paper diagram', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await paper
    .locator('math')
    .first()
    .evaluate((math) => {
      const range = document.createRange();
      range.selectNode(math);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
  await page.getByRole('button', { name: '打开青藜', exact: true }).click();
  await page.getByRole('button', { name: '引用选中文字', exact: true }).click();
  await expect(page.locator('.context-quote')).toContainText('$E=mc^2$');
  await cropInBrowser(page, info.project.name === 'mobile');
  await page.getByRole('button', { name: '附上当前文件', exact: true }).click();
  const file = page.getByRole('dialog', { name: '附上文件', exact: true });
  await file.getByText('查看将发送的文字', { exact: true }).click();
  await expect(file.locator('pre')).toContainText('\\int_0^1 x^2 dx=\\frac{1}{3}');
  await file.getByRole('button', { name: '附到对话', exact: true }).click();
  await page.getByRole('textbox', { name: '发给青藜的问题' }).fill('解释这篇论文的公式。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.chat-assistant')).toContainText('结构要点');
  expect(chat.sent[0].quote).toContain('$E=mc^2$');
  expect(chat.sent[0].files![0].text).toContain('arXiv:2503.01800v1');
  await page.getByRole('button', { name: '保存为子笔记', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开子笔记', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭青藜', exact: true }).click();
  for (const theme of ['light', 'dark', 'starry']) {
    await selectTheme(page, theme);
    await page.screenshot({ path: `test-results/arxiv-${theme}-${info.project.name}.png` });
  }
});

test('long arXiv papers allow the full text or a chosen section without silent truncation', async ({
  page,
}) => {
  await login(page);
  await page.request.put('/api/ai/settings', {
    headers: { origin: 'http://127.0.0.1:8799' },
    data: { apiKey: 'sk-e2e-placeholder-key' },
  });
  await paperImportFixture(
    page,
    paperHtml.replace('The proof continues', 'Long text '.repeat(6100) + 'The proof continues'),
  );
  const chat = await assistantFixture(page);
  await page.getByRole('button', { name: '新建', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新建笔记' });
  await chooseNodeType(form, 'arXiv 论文');
  await form
    .getByLabel('arXiv 论文地址', { exact: true })
    .fill('https://arxiv.org/abs/2503.01800v1');
  await form.getByRole('button', { name: '导入论文', exact: true }).click();
  await page.getByRole('button', { name: '打开青藜', exact: true }).click();
  await page.getByRole('button', { name: '附上当前文件', exact: true }).click();
  const file = page.getByRole('dialog', { name: '附上文件', exact: true });
  const range = file.getByRole('combobox', { name: '论文范围', exact: true });
  await expect(range).toHaveValue('all');
  await expect(range.locator('option[value="all"]')).toHaveJSProperty('disabled', false);
  await file.getByText('查看将发送的文字', { exact: true }).click();
  const fullText = await file.locator('pre').textContent();
  expect(fullText!.length).toBeGreaterThan(60_000);
  await expect(file.locator('pre')).toContainText('The proof continues');
  await expect(file.getByText(/约 [\d,]+ tokens/)).toBeVisible();
  await range.selectOption('section-0');
  await expect(file.locator('pre')).toContainText('1 Introduction');
  await expect(file.locator('pre')).not.toContainText('The proof continues');
  await expect(file.getByRole('button', { name: '附到对话', exact: true })).toBeEnabled();
  await range.selectOption('all');
  await file.getByRole('button', { name: '附到对话', exact: true }).click();
  await page.getByRole('textbox', { name: '发给青藜的问题', exact: true }).fill('概括全文');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.chat-assistant')).toContainText('结构要点');
  expect(chat.sent[0].files![0].text).toBe(fullText);
});
