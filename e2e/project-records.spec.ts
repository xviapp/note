import { expect, test } from './fixtures';
import type { NoteNode } from '../shared/types';
import type { ProjectOverview } from '../shared/projects';

test('project entries append records, track states and write through references', async ({ page }, info) => {
  test.setTimeout(60_000);
  const status = await (await page.request.get('/api/auth/status')).json();
  await page.goto(status.initialized ? '/' : '/#setup=e2e-test-only-setup-token-never-deploy-0001');
  if (!status.initialized) {
    await page.getByLabel('设置密码', { exact: true }).fill('Note2026');
    await page.getByLabel('确认密码', { exact: true }).fill('Note2026');
    await page.getByRole('button', { name: '创建笔记库' }).click();
  } else {
    await page.getByLabel('密码', { exact: true }).fill('Note2026');
    await page.getByRole('button', { name: '打开笔记库' }).click();
  }
  await expect(page.locator('.app-shell')).toBeVisible();
  const headers = { origin: 'http://127.0.0.1:8799' };
  const create = async (path: string, data: object): Promise<NoteNode> => {
    const response = await page.request.post(path, { headers, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const project = await create('/api/nodes', { kind: 'folder', title: '持续记录', project: true });
  for (const category of ['todo', 'issue', 'note'])
    await create(`/api/nodes/${project.id}/project/items`, { category, title: `${category}条目`, content: '原始说明' });
  const overview: ProjectOverview = await (await page.request.get(`/api/nodes/${project.id}/project`)).json();
  const source = await create('/api/nodes', { kind: 'markdown', title: '外部问题', content: '---\nstatus: open\n---\n\n外部原文' });
  await create('/api/nodes', { kind: 'folder', parentId: overview.directories.find((item) => item.category === 'issue')!.id, referenceId: source.id });
  for (const [category, label, finished] of [['todo', '记录进展', 'done'], ['issue', '补充讨论', 'closed'], ['note', '追加笔记', '']]) {
    await page.goto(`/n/${project.id}`);
    await page.getByRole('tab', { name: new RegExp(category === 'todo' ? '待办' : category === 'issue' ? '问题' : '笔记') }).click();
    await page.locator('.project-item-main').filter({ hasText: `${category}条目` }).click();
    await expect(page).toHaveURL(new RegExp(`category=${category}`));
    await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0);
    // Phones keep an idle composer to one line; the title appears once it is in use.
    if (info.project.name === 'desktop') await expect(page.getByLabel('记录标题')).toBeVisible();
    else {
      await expect(page.getByLabel('记录标题')).toBeHidden();
      expect((await page.getByLabel('记录内容').boundingBox())!.height).toBeLessThanOrEqual(44);
    }
    await page.getByLabel('记录内容').focus();
    await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
    await expect(page.locator('.assistant-launcher:visible')).toHaveCount(1);
    const layout = await page.locator('.quick-append-footer').evaluate((element) => {
      const form = element.querySelector('.quick-append')!.getBoundingClientRect();
      const footer = element.getBoundingClientRect();
      const title = element.querySelector('input')!.getBoundingClientRect();
      const text = element.querySelector('textarea')!.getBoundingClientRect();
      const body = element.closest('.note-reading-column')!.querySelector('.read-content')!.getBoundingClientRect();
      return { width: form.width, footerWidth: footer.width, center: Math.abs(form.x + form.width / 2 - body.x - body.width / 2), equalWidth: Math.abs(title.width - text.width), height: text.height };
    });
    expect(Math.round(layout.width)).toBeLessThanOrEqual(720);
    expect(layout.width).toBeLessThan(layout.footerWidth - 20);
    expect(layout.center).toBeLessThan(2);
    const placement = await page.locator('.quick-append').evaluate((element) => {
      const title = element.querySelector('input')!.getBoundingClientRect();
      const text = element.querySelector('textarea')!.getBoundingClientRect();
      const button = element.querySelector('button')!.getBoundingClientRect();
      return { right: button.left - text.right, besideTitle: button.left - title.right, above: text.top - button.bottom };
    });
    if (info.project.name === 'desktop') {
      expect(layout.equalWidth).toBeLessThan(1);
      expect(layout.height).toBeGreaterThanOrEqual(104);
      expect(placement.right).toBeGreaterThanOrEqual(8);
    } else {
      expect(layout.height).toBeGreaterThanOrEqual(64);
      expect(layout.height).toBeLessThanOrEqual(90);
      expect(placement.besideTitle).toBeGreaterThanOrEqual(7);
      expect(placement.above).toBeGreaterThanOrEqual(0);
    }
    await expect.poll(() => page.locator('.quick-append-footer').evaluate((element) =>
      element.getBoundingClientRect().top - document.querySelector('.assistant-launcher')!.getBoundingClientRect().bottom,
    )).toBeGreaterThanOrEqual(10);
    if (category !== 'note') {
      const title = await page.getByRole('heading', { level: 1 }).boundingBox();
      const status = await page.getByRole('combobox', { name: '条目状态' }).boundingBox();
      expect(status!.x).toBeGreaterThan(title!.x);
      expect(Math.abs(status!.y + status!.height / 2 - title!.y - title!.height / 2)).toBeLessThan(20);
    }
    await expect(page.locator('.document-meta').getByRole('button', { name: '新建', exact: true })).toHaveCount(0);
    await expect(page.locator('.note-actions > .edit-note-button')).toHaveCount(0);
    await page.getByLabel('记录标题').fill('阶段记录');
    await page.getByLabel('记录内容').fill('新增一条持续记录');
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page.getByText('新增一条持续记录', { exact: true })).toBeVisible();
    if (info.project.name === 'desktop') {
      for (let toggle = 0; toggle < 2; toggle++) {
        await page.getByRole('button', { name: '标题目录', exact: true }).click();
        const offset = await page.locator('.quick-append').evaluate((element) => {
          const form = element.getBoundingClientRect();
          const body = element.closest('.note-reading-column')!.querySelector('.read-content')!.getBoundingClientRect();
          return Math.abs(form.x + form.width / 2 - body.x - body.width / 2);
        });
        expect(offset).toBeLessThan(2);
      }
    }
    if (category === 'note') await expect(page.locator('.read-content .record')).toHaveCount(0);
    else {
      await expect(page.locator(`.records-${category} section.record`).last().locator('.record-time')).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      await expect(page.locator('.read-content h2').filter({ hasText: category === 'issue' ? '讨论' : '进展' })).toHaveCount(1);
    }
    if (finished) {
      await page.getByRole('combobox', { name: '条目状态' }).selectOption(finished);
      const finish = page.getByRole('dialog', { name: category === 'issue' ? '关闭问题' : '完成待办', exact: true });
      await finish.getByLabel(category === 'issue' ? '结论（可选）' : '完成结果（可选）').fill('按计划收尾');
      await page.screenshot({ path: info.outputPath(`${category}-finish.png`) });
      await finish.getByRole('button', { name: category === 'issue' ? '关闭问题' : '标记完成', exact: true }).click();
      await expect(page.getByRole('combobox', { name: '条目状态' })).toHaveValue(finished);
      await expect(page.getByText(category === 'todo' ? '待办 → 已完成' : '待处理 → 已关闭', { exact: true })).toBeVisible();
      await expect(page.locator('section.record.is-conclusion')).toContainText('按计划收尾');
      await page.getByLabel('记录内容').fill('结束后补充复盘');
      await expect(page.getByRole('button', { name: label, exact: true })).toBeEnabled();
      await page.getByRole('button', { name: label, exact: true }).click();
      await expect(page.getByText('结束后补充复盘', { exact: true })).toBeVisible();
      await expect(page.getByRole('combobox', { name: '条目状态' })).toHaveValue(finished);
    } else await expect(page.getByRole('combobox', { name: '条目状态' })).toHaveCount(0);
    await page.locator('.note-actions .node-menu > summary').click();
    await expect(page.locator('.note-actions .node-menu').getByRole('button', { name: '新建笔记', exact: true })).toHaveCount(0);
    await expect(page.locator('.note-actions .node-menu').getByRole('button', { name: '编辑正文', exact: true })).toBeVisible();
    await expect(page.locator('.note-actions .node-menu').getByRole('button', { name: '版本历史', exact: true })).toBeVisible();
    await page.locator('.note-actions .node-menu > summary').click();
    await expect(page.locator('.note-actions .node-menu[open]')).toHaveCount(0);
    await page.getByLabel('记录内容').click();
    await expect(page.getByLabel('记录内容')).toBeFocused();
    for (const theme of ['light', 'dark', 'starry']) {
      await page.evaluate((value) => { window.dispatchEvent(new StorageEvent('storage', { key: 'note:theme', newValue: value })); }, theme);
      await expect(page.getByRole('button', { name: label, exact: true })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`${category}-${theme}.png`) });
    }
  }
  // A physical entry also gets its category and status controls without a route context.
  await page.goto(`/n/${overview.items.find((item) => item.category === 'todo')!.id}`);
  await expect(page.getByRole('form', { name: '快捷记录' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '条目状态' })).toHaveValue('done');
  await page.goto(`/n/${project.id}`);
  await page.getByRole('tab', { name: /问题/ }).click();
  await page.locator('.project-item-main').filter({ hasText: '外部问题' }).click();
  await page.reload();
  await expect(page.getByRole('form', { name: '快捷记录' })).toBeVisible();
  await page.getByLabel('记录内容').fill('引用页面中的讨论');
  await page.getByRole('button', { name: '补充讨论', exact: true }).click();
  await expect(page.getByText('引用页面中的讨论', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '条目状态' }).selectOption('closed');
  // The conclusion is optional.
  await page.getByRole('dialog', { name: '关闭问题', exact: true }).getByRole('button', { name: '关闭问题', exact: true }).click();
  await expect(page.getByText('待处理 → 已关闭', { exact: true })).toBeVisible();
  await expect(page.locator('section.record.is-status').filter({ hasText: '待处理 → 已关闭' })).toHaveCount(1);
  const detail = await (await page.request.get(`/api/nodes/${source.id}`)).json();
  expect(detail.content).toContain('引用页面中的讨论');
  expect(detail.content).toContain('status: closed');
  await page.goto(`/n/${source.id}`);
  await expect(page.getByRole('form', { name: '快捷记录' })).toHaveCount(0);
  await expect(page.getByText('引用页面中的讨论', { exact: true })).toBeVisible();
});
