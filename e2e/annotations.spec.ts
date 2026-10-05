import { expect, test, type Locator, type Page } from './fixtures';
import { noteAction } from './note-actions';
import { preparePassword } from '../shared/password';

const headers = { origin: 'http://127.0.0.1:8799' };
const toolbar = (page: Page) => page.getByRole('toolbar', { name: '选中文字操作' });
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
    .poll(() => page.evaluate(() => CSS.highlights.get('annotation-note')?.size ?? 0))
    .toBe(1);
  expect(await page.evaluate(() => CSS.highlights.get('annotation')?.size ?? 0)).toBe(1);
  await paragraphs.nth(1).click({ position: { x: 24, y: 8 } });
  const saved = page.getByRole('dialog', { name: '批注', exact: true });
  await expect(saved.getByLabel('批注内容')).toHaveValue('这是我的想法');
  await saved.getByRole('button', { name: '关闭' }).click();
  await expect(saved).toBeHidden();

  // The list follows the text, and exports as a child note.
  await noteAction(page, '批注（2）');
  const list = page.getByRole('dialog', { name: '批注（2）' });
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
  await expect.poll(() => page.evaluate(() => CSS.highlights.get('annotation')?.size ?? 0)).toBe(0);
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
  const list = page.getByRole('dialog', { name: '批注（1）' });
  await list.getByRole('button', { name: '导出为子笔记' }).click();
  await expect(list.getByText(/（1 条）/)).toBeVisible();
  await list.locator('.annotation-item').click();
  await expect(pageInput).toHaveValue('2');
  const children = (await (await page.request.get(`/api/nodes?parent=${node.id}`)).json()).nodes;
  const child = await (await page.request.get(`/api/nodes/${children[0].id}`)).json();
  expect(child.content).toContain('第 2 页\n\n> Marked PDF page 2\n\n第二页的要点');
});
