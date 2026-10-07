import { expect, test, type Page } from './fixtures';
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
const paragraphs = Array.from(
  { length: 60 },
  (_, i) => `<div class="ltx_para"><p class="ltx_p">Paragraph ${i + 1} ${'text '.repeat(80)}</p></div>`,
).join('');
const content = paperHtml.replace('</article>', `${paragraphs}</article>`);

test('launcher after scrolling', async ({ page }) => {
  await login(page);
  const paper = await (
    await page.request.post('/api/nodes', {
      headers,
      data: { kind: 'link', title: 'P', url: 'https://arxiv.org/html/2503.01800v1' },
    })
  ).json();
  await page.route(`**/api/nodes/${paper.id}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const detail = await (await route.fetch()).json();
    await route.fulfill({
      json: { ...detail, arxiv_id: '2503.01800v1', variant: 'paper', content, attachments: [] },
    });
  });
  await page.goto(`/n/${paper.id}`);
  const launcher = page.getByRole('button', { name: '打开青藜', exact: true });
  await expect(launcher).toBeVisible();
  const info = async (label: string) =>
    console.log(
      label,
      JSON.stringify(
        await page.evaluate(() => {
          const l = [...document.querySelectorAll<HTMLElement>('.assistant-launcher')].find((x) => !x.classList.contains('global-assistant-launcher'))!;
          const s = getComputedStyle(l);
          return {
            hidden: l.hidden,
            cls: l.className,
            opacity: s.opacity,
            rect: l.getBoundingClientRect().toJSON(),
            fast: document.documentElement.dataset.fastScroll,
            scrollX: scrollX,
            docW: document.documentElement.scrollWidth,
            vw: innerWidth,
          };
        }),
      ),
    );
  await info('start');
  const box = page.viewportSize()!;
  // Touch drag on the paper.
  const session = await page.context().newCDPSession(page);
  for (let i = 0; i < 3; i++) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.width / 2, y: 600 }] });
    for (let y = 600; y > 200; y -= 40)
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.width / 2, y }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  await info('after drag');
  await page.waitForTimeout(3000);
  await info('3s later');
  await page.screenshot({ path: 'test-results/tmp-launcher.png' });
});
