import { expect, test } from './fixtures';
import { expectPreview, login, selectTheme, nav, assistantSeed } from './notebook-helpers';
import { assistantFixture, cropInBrowser } from './assistant-fixtures';
import { GLOBAL_ASSISTANT_ID } from '../shared/assistant';

test('configures reply length and saves or continues an interrupted reply without sending the draft', async ({
  page,
}, info) => {
  await login(page);
  await page.request.delete('/api/ai/settings', { headers: { origin: 'http://127.0.0.1:8799' } });
  await nav(page, '设置');
  const limit = page.getByRole('combobox', { name: '单次回复上限', exact: true });
  await expect(limit).toHaveValue('8192');
  await page.getByLabel('DeepSeek API Key', { exact: true }).fill('sk-e2e-placeholder-key');
  await page.getByRole('button', { name: '保存 AI 配置', exact: true }).click();
  await expect(page.getByText('AI 配置已保存。', { exact: true })).toBeVisible();
  await limit.selectOption('16384');
  await page.getByRole('button', { name: '保存 AI 配置', exact: true }).click();
  await expect(page.getByText('AI 配置已保存。', { exact: true })).toBeVisible();
  await page.reload();
  await expectPreview(page);
  await nav(page, '设置');
  await expect(limit).toHaveValue('16384');
  await expect(page.getByLabel('DeepSeek API Key', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: '测试连接', exact: true })).toBeEnabled();
  await limit.selectOption('8192');
  await page.getByRole('button', { name: '保存 AI 配置', exact: true }).click();
  await expect(page.getByText('AI 配置已保存。', { exact: true })).toBeVisible();

  const { node } = await assistantSeed(page, {
    kind: 'markdown',
    title: '继续阅读',
    content: '# 正文\n\n待发送的附件。',
  });
  const fixture = await assistantFixture(page, { interruptFirst: true });
  await page.goto(`/n/${node.id}`);
  await page.getByRole('button', { name: '打开青藜', exact: true }).click();
  const panel = page.getByRole('complementary', { name: '青藜', exact: true });
  const prompt = panel.getByRole('textbox', { name: '发给青藜的问题' });
  await prompt.fill('详细解释。');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  const reply = panel.locator('.chat-assistant').first();
  await expect(reply.getByRole('button', { name: '继续生成', exact: true })).toBeEnabled();
  await reply.getByRole('button', { name: '保存为子笔记', exact: true }).click();
  await expect(reply.getByRole('button', { name: '打开子笔记', exact: true })).toBeVisible();
  const partial = fixture.threads.get(node.id)!.messages[1];
  const saved = await (await page.request.get(`/api/nodes/${partial.exportedNodeId}`)).json();
  expect(saved).toMatchObject({ parent_id: node.id, kind: 'markdown', content: partial.content });
  await prompt.fill('下一条问题草稿');
  await panel.getByRole('button', { name: '附上当前文件', exact: true }).click();
  await page
    .getByRole('dialog', { name: '附上文件', exact: true })
    .getByRole('button', { name: '附到对话', exact: true })
    .click();
  await reply.getByRole('button', { name: '继续生成', exact: true }).click();
  await expect(panel.locator('.chat-assistant')).toHaveCount(2);
  await expect(
    panel
      .locator('.chat-assistant')
      .last()
      .getByRole('button', { name: '保存为子笔记', exact: true }),
  ).toBeVisible();
  expect(fixture.sent[1]).toEqual({ content: '继续生成', continueFrom: partial.id });
  await expect(prompt).toHaveValue('下一条问题草稿');
  await expect(panel.locator('.context-file')).toHaveCount(1);
  await page.screenshot({ path: `test-results/assistant-continue-${info.project.name}.png` });
  await page.reload();
  await page.getByRole('button', { name: '打开青藜', exact: true }).click();
  await expect(panel.locator('.chat-assistant')).toHaveCount(2);
  await expect(panel.getByRole('button', { name: '打开子笔记', exact: true })).toBeVisible();
});

test('file assistant quotes, crops, previews, exports and retains independent conversations', async ({
  page,
}, info) => {
  const errors: string[] = [];
  const remoteImages: string[] = [];
  const unlocks: unknown[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.url().includes('assistant-tracker.invalid')) remoteImages.push(request.url());
    if (new URL(request.url()).pathname === '/api/edit/unlock')
      unlocks.push(request.postDataJSON());
  });
  await login(page);
  await nav(page, '设置');
  await page.getByLabel('DeepSeek API Key', { exact: true }).fill('sk-e2e-placeholder-key');
  await page.getByRole('button', { name: '保存 AI 配置', exact: true }).click();
  await expect(page.getByText('AI 配置已保存。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('DeepSeek API Key', { exact: true })).toHaveValue('');
  await page.route('**/api/ai/test', (route) => route.fulfill({ json: { ok: true } }));
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(page.getByText('连接成功。', { exact: true })).toBeVisible();
  const content =
    '# 桥梁结构\n\n桥面承受荷载，通过主梁、支座传递给桥墩与基础。\n\n## 阅读记录\n\n| 构件 | 作用 |\n| --- | --- |\n| 主梁 | 传递荷载 |\n| 支座 | 连接上下部结构 |';
  const { node } = await assistantSeed(page, {
    kind: 'markdown',
    title: `桥梁阅读 · ${info.project.name}`,
    content,
  });
  const { node: other } = await assistantSeed(page, {
    kind: 'text',
    title: `独立会话 · ${info.project.name}`,
    content: '另一个文件。',
  });
  const fixture = await assistantFixture(page);
  await page.goto(`/n/${node.id}`);
  await expect(page.locator('.read-content p').first()).toBeVisible();
  await page
    .locator('.read-content p')
    .first()
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
  await page.getByRole('button', { name: '打开青藜', exact: true }).click();
  await page.getByRole('button', { name: '引用选中文字', exact: true }).click();
  await expect(page.locator('.context-quote')).toContainText('桥面承受荷载');
  await cropInBrowser(page, info.project.name === 'mobile');
  await page.getByAltText('待发送截图').click();
  await expect(page.getByRole('dialog', { name: '待发送截图', exact: true })).toBeVisible();
  await page
    .getByRole('dialog', { name: '待发送截图', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: '发给青藜的问题' })
    .fill('结合引用与截图，整理结构要点。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const panel = page.getByRole('complementary', { name: '青藜' });
  await expect(panel.getByRole('heading', { name: '结构要点', exact: true })).toBeVisible();
  expect(fixture.sent[0].quote).toBe('桥面承受荷载，通过主梁、支座传递给桥墩与基础。');
  expect(fixture.sent[0].image).toMatch(/^data:image\/jpeg;base64,/);
  expect(Buffer.from(fixture.sent[0].image!.split(',')[1], 'base64').length).toBeLessThanOrEqual(
    1048576,
  );
  expect(remoteImages).toEqual([]);
  await expectPreview(page);
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  for (const theme of ['light', 'dark', 'starry']) {
    await selectTheme(page, theme);
    await page.screenshot({ path: `test-results/assistant-${theme}-${info.project.name}.png` });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.getByRole('button', { name: '保存为子笔记', exact: true }).click();
  await expect(panel.getByRole('button', { name: '打开子笔记', exact: true })).toBeVisible();
  const savedId = fixture.threads.get(node.id)!.messages[1].exportedNodeId!;
  const saved = await (await page.request.get(`/api/nodes/${savedId}`)).json();
  expect(saved.parent_id).toBe(node.id);
  expect(saved.kind).toBe('markdown');
  expect(saved.content).toContain('# 结构要点');
  expect((await (await page.request.get(`/api/nodes/${node.id}`)).json()).content).toBe(content);
  await page.reload();
  await page.getByRole('button', { name: '打开青藜', exact: true }).click();
  await expect(panel.getByRole('button', { name: '打开子笔记', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '清空会话', exact: true }).click();
  const clear = page.getByRole('dialog', { name: '清空这个文件的会话？', exact: true });
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await clear.getByRole('button', { name: '取消', exact: true }).click();
  await expect(panel.getByRole('button', { name: '打开子笔记', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '清空会话', exact: true }).click();
  await clear.getByRole('button', { name: '清空会话', exact: true }).click();
  await expect(panel.locator('.chat-message')).toHaveCount(0);
  expect((await (await page.request.get(`/api/nodes/${savedId}`)).json()).content).toBe(
    saved.content,
  );
  await page.goto(`/n/${other.id}`);
  await page.getByRole('button', { name: '打开青藜', exact: true }).click();
  await expect(page.locator('.chat-message')).toHaveCount(0);
  await expect(page.getByText('附上文件、选中文字或截图，开始提问。')).toBeVisible();
  await page.getByRole('button', { name: '关闭青藜', exact: true }).click();
  await nav(page, '设置');
  await page.getByRole('button', { name: '清除配置', exact: true }).click();
  await page
    .getByRole('dialog', { name: '清除 AI 配置？', exact: true })
    .getByRole('button', { name: '清除配置', exact: true })
    .click();
  await expect(page.getByText('AI 配置已清除。', { exact: true })).toBeVisible();
  expect(unlocks).toEqual([]);
  expect(errors).toEqual([]);
});

test('global Qingli is available across pages, separate from file chats and saves root notes', async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    (window as any).androidBridge = {};
  });
  await login(page);
  await page.request.put('/api/ai/settings', {
    headers: { origin: 'http://127.0.0.1:8799' },
    data: { apiKey: 'sk-e2e-placeholder-key' },
  });
  const { node } = await assistantSeed(page, {
    kind: 'markdown',
    title: `独立对话 ${info.project.name}`,
    content: '# 当前正文',
  });
  const fixture = await assistantFixture(page);
  const launcher = page.getByRole('button', { name: '打开全局青藜', exact: true });
  await expect(launcher).toBeVisible();
  const buttonBox = (await launcher.boundingBox())!;
  const navBox = (await page.locator('.phone-bottom-nav').boundingBox())!;
  expect(buttonBox.y + buttonBox.height).toBeLessThan(navBox.y);
  await launcher.click();
  const global = page.getByRole('complementary', { name: '全局青藜', exact: true });
  await expect(global.getByRole('button', { name: '附上当前文件', exact: true })).toHaveCount(0);
  const input = global.getByRole('textbox', { name: '发给青藜的问题', exact: true });
  await input.fill('独立的全局问题');
  await global.getByRole('button', { name: '发送', exact: true }).click();
  await expect(global.getByRole('heading', { name: '结构要点', exact: true })).toBeVisible();
  await global.getByRole('button', { name: '保存为笔记', exact: true }).click();
  await expect(global.getByRole('button', { name: '打开笔记', exact: true })).toBeVisible();
  const reply = fixture.threads.get(GLOBAL_ASSISTANT_ID)!.messages[1];
  const saved = await (await page.request.get(`/api/nodes/${reply.exportedNodeId}`)).json();
  expect(saved.parent_id).toBeNull();
  await global.getByRole('button', { name: '关闭青藜', exact: true }).click();
  await page
    .locator('.phone-bottom-nav')
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await launcher.click();
  await expect(global.getByText('独立的全局问题', { exact: true })).toBeVisible();
  await global.getByRole('button', { name: '关闭青藜', exact: true }).click();
  await page.goto(`/n/${node.id}`);
  await page.getByRole('button', { name: '打开青藜', exact: true }).click();
  const file = page.getByRole('complementary', { name: '青藜', exact: true });
  await expect(file.getByText('独立的全局问题', { exact: true })).toHaveCount(0);
  await file.getByRole('textbox', { name: '发给青藜的问题', exact: true }).fill('保留文件草稿');
  await file.getByRole('button', { name: '全局对话', exact: true }).click();
  await expect(file).toBeHidden();
  await expect(global.getByText('独立的全局问题', { exact: true })).toBeVisible();
  await expect(global.getByRole('button', { name: '附上当前文件', exact: true })).toBeVisible();
  await page.screenshot({ path: `test-results/global-qingli-${info.project.name}.png` });
  await global.getByRole('button', { name: '文件对话', exact: true }).click();
  await expect(file.getByRole('textbox', { name: '发给青藜的问题', exact: true })).toHaveValue(
    '保留文件草稿',
  );
});
