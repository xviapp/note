import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures';
import { preparePassword } from '../shared/password';

const equations = readFileSync(
  new URL('../tests/fixtures/arxiv-equation.html', import.meta.url),
  'utf8',
);

test('saved paper equations keep their notation, hide TeX annotations and scroll without clipping', async ({
  page,
  baseURL,
}, info) => {
  const headers = { origin: new URL(baseURL!).origin };
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
  const response = await page.request.post('/api/nodes', {
    headers,
    data: { kind: 'link', title: '论文公式', url: 'https://arxiv.org/html/2503.01800v1' },
  });
  expect(response.ok()).toBe(true);
  const note = await response.json();
  await page.route(`**/api/nodes/${note.id}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const detail = await response.json();
    return route.fulfill({
      json: {
        ...detail,
        arxiv_id: '2503.01800v1',
        content: `<article class="ltx_document"><section><h2>公式</h2>${equations}</section></article>`,
      },
    });
  });
  const paper = page.locator('.paper-body');
  for (const reopen of [false, true]) {
    if (reopen) await page.reload();
    else await page.goto(`/n/${note.id}`);
    await expect(paper.locator('math')).toHaveCount(3);
    await page.evaluate(() => document.fonts.ready);
    const equation = paper.locator('math').first();
    await expect(equation.locator('msub')).toHaveCount(2);
    await expect(equation).toContainText('𝒬');
    const exposedSources = await paper.locator('math').evaluateAll((formulas) =>
      formulas.flatMap((math) =>
        Array.from(math.childNodes)
          .filter((child) => child.nodeType === Node.TEXT_NODE && child.textContent!.trim())
          .map((child) => child.textContent),
      ),
    );
    expect(exposedSources, 'TeX annotations must not become visible formula text').toEqual([]);
    await expect(paper).not.toContainText(String.raw`\partial`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  const longEquation = paper.locator('table').last();
  if (info.project.name === 'mobile') {
    expect(await longEquation.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
    const start = await longEquation.evaluate((node) => ({
      frame: node.getBoundingClientRect().left,
      formula: node.querySelector('math')!.getBoundingClientRect().left,
    }));
    expect(start.formula).toBeGreaterThanOrEqual(start.frame);
    await longEquation.evaluate((node) => {
      node.scrollLeft = node.scrollWidth;
    });
    expect(await longEquation.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    const end = await longEquation.evaluate((node) => ({
      frame: node.getBoundingClientRect().right,
      formula: node.querySelector('math')!.getBoundingClientRect().right,
    }));
    expect(end.formula).toBeLessThanOrEqual(end.frame);
    await longEquation.evaluate((node) => {
      node.scrollLeft = 0;
    });
  }
  await page.screenshot({ path: info.outputPath('paper-equations.png') });
});
