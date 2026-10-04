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

test('a paper translates paragraph by paragraph and both sides scroll together', async ({
  page,
}, info) => {
  await login(page);
  const paper = await (
    await page.request.post('/api/nodes', {
      headers,
      data: {
        kind: 'link',
        title: `对照论文 · ${info.project.name}`,
        url: 'https://arxiv.org/html/2503.01800v1',
      },
    })
  ).json();
  await page.route(`**/api/nodes/${paper.id}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const detail = await (await route.fetch()).json();
    await route.fulfill({
      json: { ...detail, arxiv_id: '2503.01800v1', content, attachments: [] },
    });
  });
  // The Worker suite covers saving and the model call; here the server is modelled.
  const saved: Record<string, string> = {};
  const batches: { hash: string; text: string }[][] = [];
  await page.route(`**/api/nodes/${paper.id}/paper-translation**`, async (route) => {
    const request = route.request();
    if (request.method() === 'GET')
      return route.fulfill({ json: { language: 'zh-CN', blocks: saved, updatedAt: null } });
    const body = request.postDataJSON();
    batches.push(body.blocks);
    for (const block of body.blocks) saved[block.hash] = `译文：${block.text}`;
    await route.fulfill({
      json: {
        language: body.language,
        blocks: Object.fromEntries(
          body.blocks.map((b: { hash: string }) => [b.hash, saved[b.hash]]),
        ),
        updatedAt: Date.now(),
      },
    });
  });
  await page.goto(`/n/${paper.id}`);
  await page
    .locator('.note-actions')
    .getByRole('button', { name: '对照阅读', exact: true })
    .click();
  const view = page.getByRole('dialog', { name: `对照阅读：${paper.title}` });
  await expect(view).toBeVisible();
  const progress = view.getByRole('status');
  await expect(progress).toContainText('已翻译 0/');
  await view.getByRole('button', { name: '翻译全文' }).click();
  await expect(progress).toContainText('已全部翻译');
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
