import { expect, test, type Page } from './fixtures';
import { preparePassword } from '../shared/password';
import type { ChatHistory, ChatMessage } from '../shared/assistant';

const reportedFormula = String.raw`$$D_N := \Big{ z_N = (z_1, \cdots, z_N) \in \mathbb{T}^{dN} \times \mathbb{R}^{dN} : |x_i - x_j|_T \geq \varepsilon\ (\forall i \neq j) \Big}. \qquad (1.3)$$`;
const markdown = [
  '# 公式阅读',
  String.raw`行内公式 $E=mc^2$，正文继续。转义金额 \$5。`,
  reportedFormula,
  String.raw`$$
\begin{aligned}
\int_0^1 x^2\,dx &= \frac{1}{3} \\
A &= \begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}
\end{aligned}\tag{2}
$$`,
  '```math\n\\sum_{i=1}^{N} i = \\frac{N(N+1)}{2}\n```',
  '```text\n$$原样保留$$\n\\Big{ x \\Big}\n```',
  '`$内联代码$`',
  String.raw`标准括号 $\Big\{x\Big\}$。`,
  String.raw`尚未完成的公式 $\frac{1}{$，后面的公式 $y^2$ 仍可阅读。`,
].join('\n\n');

async function prepare(page: Page, baseURL: string) {
  const origin = new URL(baseURL).origin;
  const status = await (await page.request.get('/api/auth/status')).json();
  const response = await page.request.post(
    status.initialized ? '/api/auth/login' : '/api/auth/setup',
    {
      headers: { origin },
      data: status.initialized
        ? { password: await preparePassword('Note2026', status.password) }
        : {
            token: 'e2e-test-only-setup-token-never-deploy-0001',
            password: await preparePassword('Note2026'),
          },
    },
  );
  expect(response.ok()).toBe(true);
  const created = await page.request.post('/api/nodes', {
    headers: { origin },
    data: { kind: 'markdown', title: '公式阅读', content: markdown },
  });
  expect(created.ok()).toBe(true);
  return { origin, node: await created.json() };
}

test('Markdown renders inline and display math, preserves source and code, and scrolls long formulas', async ({
  page,
  baseURL,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { node } = await prepare(page, baseURL!);
  await page.goto(`/n/${node.id}`);
  const reading = page.locator('.read-content .markdown-body');
  await expect(reading.locator('.katex')).toHaveCount(6);
  await expect(reading.locator('.katex-display')).toHaveCount(3);
  await expect(reading.locator('.katex-error')).toHaveCount(1);
  await expect(reading.locator('.katex-display').first().locator('annotation')).toContainText(
    String.raw`\Big\{`,
  );
  await expect(reading.locator('pre code')).toHaveText('$$原样保留$$\n\\Big{ x \\Big}\n');
  await expect(reading.locator('pre .katex')).toHaveCount(0);
  await expect(reading).toContainText('转义金额 $5');
  const original = await (await page.request.get(`/api/nodes/${node.id}`)).json();
  expect(original.content).toBe(markdown);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const display = reading.locator('.katex-display').first();
  if (info.project.name === 'mobile') {
    expect(await display.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
    expect(
      await display.evaluate(
        (node) =>
          node.querySelector('.katex')!.getBoundingClientRect().left >=
          node.getBoundingClientRect().left - 1,
      ),
    ).toBe(true);
    await display.evaluate((node) => {
      node.scrollLeft = node.scrollWidth;
    });
    expect(await display.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    await display.evaluate((node) => {
      node.scrollLeft = 0;
    });
  }
  await page.screenshot({ path: info.outputPath('markdown-math.png') });
  expect(errors).toEqual([]);
});

test('chat renders the reported formula and exported Markdown while keeping TeX HTML commands disabled', async ({
  page,
  baseURL,
}, info) => {
  const errors: string[] = [],
    external: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.url().includes('math-probe.invalid')) external.push(request.url());
  });
  const { origin, node } = await prepare(page, baseURL!);
  await page.request.put('/api/ai/settings', {
    headers: { origin },
    data: { apiKey: 'sk-e2e-placeholder-key' },
  });
  const content =
    `${reportedFormula}\n\n行内 $\\alpha + \\beta$。\n\n` +
    String.raw`$\includegraphics{https://math-probe.invalid/image.png}$ $\href{javascript:window.mathInjected=true}{X}$ $\htmlClass{unsafe}{X}$`;
  const assistant: ChatMessage = {
    id: crypto.randomUUID(),
    sequence: 2,
    role: 'assistant',
    status: 'completed',
    content,
    createdAt: Date.now(),
  };
  const history: ChatHistory = { messages: [assistant], nextBefore: null, busy: false };
  await page.route(`**/api/nodes/${node.id}/assistant`, (route) =>
    route.fulfill({ json: history }),
  );
  let savedId = '';
  await page.route(`**/api/nodes/${node.id}/assistant/${assistant.id}/export`, async (route) => {
    const response = await page.request.post('/api/nodes', {
      headers: { origin },
      data: { parentId: node.id, kind: 'markdown', title: '公式回复', content },
    });
    const saved = await response.json();
    savedId = saved.id;
    assistant.exportedNodeId = saved.id;
    await route.fulfill({ status: response.status(), json: saved });
  });
  await page.goto(`/n/${node.id}`);
  await page.getByRole('button', { name: '打开青藜', exact: true }).click();
  const reply = page.locator('.chat-assistant');
  await expect(reply.locator('.katex-display')).toHaveCount(1);
  await expect(reply.locator('.katex-error')).toHaveCount(0);
  await expect(reply.locator('img, a[href^="javascript:"], .unsafe')).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as Window & { mathInjected?: boolean }).mathInjected),
  ).toBeUndefined();
  await page.evaluate(() => document.fonts.ready);
  expect(
    await reply.locator('.katex-display').evaluate((node) => node.scrollWidth > node.clientWidth),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('chat-math.png') });
  await reply.getByRole('button', { name: '保存为子笔记', exact: true }).click();
  await reply.getByRole('button', { name: '打开子笔记', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/n/${savedId}$`));
  await expect(page.locator('.read-content .katex-display')).toHaveCount(1);
  const saved = await (await page.request.get(`/api/nodes/${savedId}`)).json();
  expect(saved).toMatchObject({ parent_id: node.id, content });
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});
