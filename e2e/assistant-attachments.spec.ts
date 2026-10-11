import { expect, test } from './fixtures';
import { expectPreview, login, assistantSeed } from './notebook-helpers';
import { assistantFixture } from './assistant-fixtures';

test('context overflow keeps the draft and attachment and allows a smaller submission', async ({
  page,
}, info) => {
  await login(page);
  await page.request.put('/api/ai/settings', {
    headers: { origin: 'http://127.0.0.1:8799' },
    data: { apiKey: 'sk-e2e-placeholder-key', maxTokens: 8192 },
  });
  const { node } = await assistantSeed(page, {
    kind: 'markdown',
    title: '上下文容量',
    content: '参考内容。',
  });
  await page.goto(`/n/${node.id}`);
  await page.getByRole('button', { name: '打开青藜', exact: true }).click();
  const panel = page.getByRole('complementary', { name: '青藜', exact: true });
  const input = panel.getByRole('textbox', { name: '发给青藜的问题', exact: true });
  await input.fill('请读取完整附件。');
  await page.getByLabel('选择聊天附件', { exact: true }).setInputFiles({
    name: 'large.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('*'.repeat(900_000)),
  });
  const file = page.getByRole('dialog', { name: '附上文件', exact: true });
  await expect(file.getByText(/约 [\d,]+ tokens/)).toBeVisible();
  await file.getByRole('button', { name: '附到对话', exact: true }).click();
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('超过可用输入预算');
  await expect(input).toHaveValue('请读取完整附件。');
  await expect(panel.locator('.context-file')).toHaveCount(1);
  await expect(panel.locator('.chat-message')).toHaveCount(0);
  const history = await (await page.request.get(`/api/nodes/${node.id}/assistant`)).json();
  expect(history).toMatchObject({ messages: [], busy: false });
  await page.screenshot({ path: `test-results/assistant-context-${info.project.name}.png` });
  await panel.getByRole('button', { name: '移除附件 large.txt', exact: true }).click();
  // More characters, but fewer estimated tokens. This also exercises the
  // browser's SSE parser with an echoed attachment snapshot larger than 1 MiB.
  const fittingText = 'Long research text. '.repeat(60_000) + 'COMPLETE END';
  await page.getByLabel('选择聊天附件', { exact: true }).setInputFiles({
    name: 'fitting.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(fittingText),
  });
  await file.getByRole('button', { name: '附到对话', exact: true }).click();
  const chat = await assistantFixture(page);
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect(panel.locator('.chat-assistant')).toContainText('结构要点');
  expect(chat.sent[0].files![0].text).toBe(fittingText);
  await expect(input).toHaveValue('');
  await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('chat attachments preview current notes and local text or images before sending', async ({
  page,
}, info) => {
  await login(page);
  const content = '# 当前文件全文\n\n只有主动附上后，助手才会收到这段内容。';
  const { node } = await assistantSeed(page, {
    kind: 'markdown',
    title: '文件对照阅读',
    content,
  });
  await page.request.put('/api/ai/settings', {
    headers: { origin: 'http://127.0.0.1:8799' },
    data: { apiKey: 'sk-e2e-placeholder-key' },
  });
  const fixture = await assistantFixture(page);
  const uploads: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/assistant/files')) uploads.push(request.url());
  });
  await page.goto(`/n/${node.id}`);
  await page.getByRole('button', { name: '打开青藜', exact: true }).click();
  await page.getByRole('button', { name: '附上当前文件', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '附上文件', exact: true });
  await dialog.getByText('查看将发送的文字', { exact: true }).click();
  await expect(dialog.locator('pre')).toHaveText(content);
  await dialog.getByRole('button', { name: '附到对话', exact: true }).click();
  await page.getByLabel('选择聊天附件', { exact: true }).setInputFiles({
    name: '对照.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('另一份本地参考资料。'),
  });
  await expect(dialog.getByRole('button', { name: '附到对话' })).toBeEnabled();
  await dialog.getByRole('button', { name: '附到对话' }).click();
  const picture = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 80;
    canvas.height = 50;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#427aa8';
    context.fillRect(0, 0, 80, 50);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.getByLabel('选择聊天附件', { exact: true }).setInputFiles({
    name: '图片.png',
    mimeType: 'image/png',
    buffer: Buffer.from(picture, 'base64'),
  });
  await expect(dialog.getByAltText('文件图片预览')).toBeVisible();
  await dialog.getByRole('button', { name: '附到对话' }).click();
  await expect(page.locator('.context-file')).toHaveCount(3);
  await expect(page.getByRole('button', { name: '另选文件', exact: true })).toBeDisabled();
  expect(uploads).toHaveLength(0);
  expect(fixture.sent).toHaveLength(0);
  await page.screenshot({ path: `test-results/file-attachments-${info.project.name}.png` });
  await page.getByRole('button', { name: '移除附件 图片.png', exact: true }).click();
  await page.getByRole('textbox', { name: '发给青藜的问题' }).fill('比较两份资料。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.chat-assistant')).toContainText('结构要点');
  expect(fixture.sent[0].files).toHaveLength(2);
  expect(fixture.sent[0].files![0]).toMatchObject({
    kind: 'markdown',
    text: content,
    images: [],
  });
  expect(fixture.sent[0].files![1]).toMatchObject({
    name: '对照.txt',
    text: '另一份本地参考资料。',
    sourceId: expect.any(String),
  });
  expect(uploads).toHaveLength(1);
  await expect(page.locator('.context-file')).toHaveCount(0);
  await expectPreview(page);
  await page.reload();
  await page.getByRole('button', { name: '打开青藜', exact: true }).click();
  await expect(page.locator('.chat-file-card')).toHaveCount(2);
  await page.locator('.chat-file-card').first().locator('summary').click();
  await expect(page.locator('.chat-file-card').first().locator('pre')).toHaveText(content);
  expect((await (await page.request.get(`/api/nodes/${node.id}`)).json()).content).toBe(content);
});
