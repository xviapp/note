import { expect, test, type Page } from './fixtures';
import { preparePassword } from '../shared/password';
import type { NoteDetail, NoteNode } from '../shared/types';

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
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto('/');
}

test('projects index Markdown and references, write status to source files and remain usable in every palette', async ({
  page,
}, info) => {
  await login(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: '新建', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新建笔记' });
  await form.getByRole('radio', { name: '项目', exact: true }).check();
  await form.getByLabel('标题', { exact: true }).fill('页间开发');
  await form.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.locator('.document-kind')).toHaveText('项目');
  const projectUrl = new URL(page.url()).pathname;
  const projectId = projectUrl.split('/').pop()!;
  const panel = page.getByRole('region', { name: '项目概览' });
  await expect(panel).toBeVisible();
  expect(
    await page
      .locator('.note-article')
      .evaluate(
        (element) =>
          Array.from(element.childNodes).filter(
            (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
          ).length,
      ),
  ).toBe(0);
  for (const [label, title, body] of [
    ['待办', '支持文件与文件夹引用', '同一份 Markdown 可以在多个项目中使用。'],
    ['问题', '离线后图片显示不完整', '检查已保存文件的图片读取过程。'],
    ['笔记', '项目目录与索引方案', '文件决定内容，目录决定分类，项目页面自动汇总。'],
  ]) {
    await panel.getByRole('tab', { name: new RegExp(label) }).click();
    await panel.getByRole('button', { name: `新建${label}` }).click();
    const dialog = page.getByRole('dialog', { name: `新建${label}` });
    await dialog.getByLabel('标题', { exact: true }).fill(title);
    await dialog.getByLabel('说明（可选）').fill(body);
    await dialog.getByRole('button', { name: '创建', exact: true }).click();
    await expect(panel.locator('.project-item-main', { hasText: title })).toBeVisible();
  }
  await panel.getByRole('tab', { name: /待办/ }).click();
  await panel.getByLabel('支持文件与文件夹引用的状态').selectOption('doing');
  await expect(panel.getByLabel('支持文件与文件夹引用的状态')).toBeEnabled();
  await panel.getByLabel('支持文件与文件夹引用的状态').selectOption('done');
  await expect(panel.getByRole('progressbar', { name: '待办完成进度' })).toHaveAttribute(
    'value',
    '100',
  );
  await panel.getByLabel('只看未完成').check();
  await expect(panel).toContainText('所有待办均已完成');
  await panel.getByLabel('只看未完成').uncheck();
  await panel.locator('.project-item-main', { hasText: '支持文件与文件夹引用' }).click();
  const sourceId = new URL(page.url()).pathname.split('/').pop()!;
  const source: NoteDetail = await (await page.request.get(`/api/nodes/${sourceId}`)).json();
  expect(source.content).toContain('status: done');
  await expect(page.locator('.read-content')).toContainText('同一份 Markdown');
  await expect(page.locator('.read-content')).not.toContainText('status:');

  // Use the UI to place an outside source into the project's todo directory.
  const response = await page.request.post('/api/nodes', {
    headers,
    data: {
      kind: 'markdown',
      title: '共享任务.md',
      content: '---\ntitle: 共享任务\nstatus: todo\n---\n\n从引用读取原文件。',
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const shared: NoteNode = await response.json();
  await page.goto(projectUrl);
  await panel.getByRole('button', { name: '打开目录' }).click();
  await page
    .locator('.document-heading')
    .getByRole('button', { name: '新建', exact: true })
    .click();
  await form.getByRole('radio', { name: '文件／文件夹引用', exact: true }).check();
  await form.getByLabel('标题', { exact: true }).fill('共享任务引用');
  await form
    .locator('.node-picker')
    .getByRole('button', { name: '共享任务.md', exact: true })
    .click();
  await form.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByRole('region', { name: '引用内容' })).toContainText('共享任务.md');
  await page.goto(projectUrl);
  await expect(panel.locator('.project-item-main', { hasText: '共享任务' })).toHaveCount(1);
  await panel.getByLabel('共享任务的状态').selectOption('doing');
  await expect(panel.getByLabel('共享任务的状态')).toBeEnabled();
  expect((await (await page.request.get(`/api/nodes/${shared.id}`)).json()).content).toContain(
    'status: doing',
  );

  // A concurrent body change must not be overwritten, and its error stays visible.
  const current: NoteDetail = await (await page.request.get(`/api/nodes/${shared.id}`)).json();
  const { token } = await (
    await page.request.post('/api/edit/unlock', { headers, data: { nodeId: shared.id } })
  ).json();
  const changed = await page.request.put(`/api/nodes/${shared.id}/content`, {
    headers: { ...headers, 'x-note-edit': token },
    data: {
      revision: current.revision,
      content: current.content.replace('status: doing', 'status: done'),
      attachments: [],
    },
  });
  expect(changed.ok(), await changed.text()).toBe(true);
  await panel.getByLabel('共享任务的状态').selectOption('todo');
  await expect(panel.getByRole('alert')).toContainText('已在其他页面更新');
  await expect(panel.getByLabel('共享任务的状态')).toHaveValue('done');
  await panel.getByRole('button', { name: '刷新项目' }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);

  for (const [label, palette] of [
    ['白天', 'light'],
    ['夜间', 'dark'],
    ['星空', 'starry'],
  ]) {
    await page.goto('/settings/theme');
    await page.getByRole('radio', { name: label, exact: true }).check();
    await page.goto(projectUrl);
    await expect(page.locator('html')).toHaveAttribute('data-theme', palette);
    await expect(panel.locator('.project-item')).toHaveCount(2);
    for (const category of ['todo', 'issue', 'note'])
      await expect(panel.locator(`.project-tabs .kind-${category}`)).toHaveCount(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const stateBounds = await panel.getByLabel('共享任务的状态').boundingBox();
    expect(stateBounds!.x + stateBounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    for (const [category, name, count] of [
      ['todo', '待办', 2],
      ['issue', '问题', 1],
      ['note', '笔记', 1],
    ] as const) {
      await panel.getByRole('tab', { name: new RegExp(name) }).click();
      await expect(panel.locator('.project-item')).toHaveCount(count);
      await page.screenshot({
        path: `test-results/project-${category}-${palette}-${info.project.name}.png`,
      });
    }
  }
  await panel.getByRole('tab', { name: /待办/ }).click();
  await panel.getByRole('tab', { name: /待办/ }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(panel.getByRole('tab', { name: /问题/ })).toBeFocused();
  await expect(panel.locator('.project-item')).toHaveCount(1);
  expect(
    (await (await page.request.get(`/api/nodes/${projectId}/project`)).json()).items,
  ).toHaveLength(4);
  expect(errors).toEqual([]);
});
