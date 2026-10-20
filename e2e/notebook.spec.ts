import { expect, test } from './fixtures';
import { noteAction } from './note-actions';
import { expectPreview, login, createNote, edit, nav, assistantSeed, writeSource } from './notebook-helpers';

test('default preview, editing, save/history, favorites, trash and restore', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  await createNote(page, `阅读手记 · ${info.project.name}`);
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  // Clicking 编辑正文 opens the editor without another question.
  await edit(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const content =
    '# 一个安静的阅读空间\n\n把想法留在页间，让资料有迹可循。\n\n## 本周的阅读\n\n- [x] 整理手边的资料\n- [ ] 留一点时间给思考\n\n> 阅读，是与自己的一次长谈。\n\n## 一些值得记住的事\n\n| 内容 | 状态 |\n| --- | --- |\n| 随手笔记 | 已整理 |\n| 收藏资料 | 继续读 |\n\n```js\nconst nextPage = () => keepReading();\n```\n\n## 下一页\n\n按自己的节奏，慢慢读。\n';
  await page.getByRole('textbox', { name: 'Markdown 源码' }).fill(content);
  if (info.project.name === 'mobile') {
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await expect(
      page.locator('.read-content').getByRole('heading', { name: '一个安静的阅读空间' }),
    ).toBeVisible();
    await page.getByRole('button', { name: '源码', exact: true }).click();
  }
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await expect(
    page.locator('.read-content').getByRole('heading', { name: '本周的阅读' }),
  ).toBeVisible();
  await expect(page.locator('.read-content input[type=checkbox]').first()).toBeDisabled();
  await noteAction(page, '收藏笔记');
  const url = page.url();
  await page.reload();
  await expectPreview(page);
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await expect(page.locator('.note-actions .is-favorite')).toHaveCount(1);
  if (info.project.name === 'mobile') {
    await page.getByRole('button', { name: '标题目录', exact: true }).click();
    await page
      .getByRole('dialog', { name: '标题目录', exact: true })
      .getByRole('button', { name: '一些值得记住的事', exact: true })
      .click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } else {
    const toggle = page.getByRole('button', { name: '标题目录', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(page.locator('.desktop-toc')).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(page.locator('.desktop-toc')).toBeVisible();
  }
  await page.screenshot({
    path: `test-results/reading-${info.project.name}.png`,
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await edit(page);
  await page.getByRole('textbox', { name: 'Markdown 源码' }).fill(`${content}\n修改后的内容。`);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await noteAction(page, '版本历史');
  const history = page.getByRole('dialog', { name: '版本历史', exact: true });
  await history.getByRole('button', { name: /版本 2/ }).click();
  await history.getByRole('button', { name: '恢复此版本', exact: true }).click();
  await page
    .getByRole('dialog', { name: '恢复这个版本？' })
    .getByRole('button', { name: '确认并恢复' })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.read-content')).not.toContainText('修改后的内容。');
  await nav(page, '收藏');
  await expect(
    page.locator('.node-list').getByText(`阅读手记 · ${info.project.name}`, { exact: true }),
  ).toBeVisible();
  await page.goto(url);
  await page
    .locator('.note-actions')
    .getByRole('button', { name: `管理 阅读手记 · ${info.project.name}` })
    .click();
  await page
    .locator('.note-actions')
    .getByRole('button', { name: '移到回收站', exact: true })
    .click();
  // A single note needs no confirmation; the toast offers 撤销 instead.
  await expect(page.getByRole('status').filter({ hasText: '已移到回收站' })).toBeVisible();
  await nav(page, '回收站');
  await page
    .locator('.trash-row')
    .filter({ hasText: `阅读手记 · ${info.project.name}` })
    .getByRole('button', { name: '恢复', exact: true })
    .click();
  await expect(
    page.locator('.trash-row').filter({ hasText: `阅读手记 · ${info.project.name}` }),
  ).toHaveCount(0);
  await nav(page, '收藏');
  await page
    .locator('.node-list')
    .getByText(`阅读手记 · ${info.project.name}`, { exact: true })
    .click();
  await expect(
    page.locator('.read-content').getByRole('heading', { name: '本周的阅读' }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('drafts survive canceled navigation and expired file confirmation; new tabs open in preview', async ({
  page,
  context,
}, info) => {
  await login(page);
  await createNote(page, `草稿保护 · ${info.project.name}`);
  await edit(page);
  await page.getByRole('textbox', { name: 'Markdown 源码' }).fill('这是一份尚未保存的草稿。');
  await nav(page, '收藏');
  await page
    .getByRole('dialog', { name: '还有未保存的修改' })
    .getByRole('button', { name: '继续编辑', exact: true })
    .click();
  if (
    info.project.name === 'mobile' &&
    (await page.getByRole('button', { name: '关闭侧栏' }).isVisible())
  )
    await page.getByRole('button', { name: '关闭侧栏' }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown 源码' })).toContainText(
    '尚未保存的草稿',
  );
  const other = await context.newPage();
  await other.goto(page.url());
  await expectPreview(other);
  await expect(other.locator('.cm-editor')).toHaveCount(0);
  await other.close();
  let expired = true;
  await page.route('**/api/nodes/*/content', async (route) => {
    if (expired && route.request().method() === 'PUT') {
      expired = false;
      await route.fulfill({
        status: 403,
        json: {
          error: '编辑确认已失效，请重新确认；当前编辑内容会保留。',
          code: 'EDIT_LOCKED',
        },
      });
    } else await route.fallback();
  });
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('编辑确认已失效');
  await expect(page.getByRole('textbox', { name: 'Markdown 源码' })).toContainText(
    '尚未保存的草稿',
  );
  await page.getByRole('button', { name: '重新确认编辑', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('编辑确认已更新');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await expect(page.locator('.read-content')).toContainText('尚未保存的草稿');
});

test('creation, rename, moving and storage settings work without unlocking file editing', async ({
  page,
}, info) => {
  await login(page);
  const unlocks: unknown[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/edit/unlock')
      unlocks.push(request.postDataJSON());
  });
  const title = `自由整理 · ${info.project.name}`;
  await createNote(page, title);
  // Only opening the new, empty note for writing unlocks it; nothing below may.
  expect(unlocks).toHaveLength(1);
  unlocks.length = 0;
  const id = page.url().split('/').at(-1)!;
  const { node: destination } = await assistantSeed(page, {
    kind: 'folder',
    title: `整理目录 · ${info.project.name}`,
  });
  const actions = page.locator('.note-actions');
  await actions.getByRole('button', { name: `管理 ${title}`, exact: true }).click();
  await actions.getByRole('button', { name: '重命名', exact: true }).click();
  const rename = page.getByRole('dialog', { name: '修改笔记信息', exact: true });
  await rename.getByLabel('标题', { exact: true }).fill(`${title}已改名`);
  await rename.getByRole('button', { name: '保存信息', exact: true }).click();
  await expect(page.getByRole('heading', { name: `${title}已改名`, exact: true })).toBeVisible();
  // The pen beside the title renames in place; Escape leaves the title as it was.
  const heading = page.locator('.document-heading');
  await heading.getByRole('button', { name: '修改标题', exact: true }).click();
  await heading.getByRole('textbox', { name: '笔记标题', exact: true }).fill('不会保存');
  await heading.getByRole('textbox', { name: '笔记标题', exact: true }).press('Escape');
  await expect(page.getByRole('heading', { name: `${title}已改名`, exact: true })).toBeVisible();
  await heading.getByRole('button', { name: '修改标题', exact: true }).click();
  await heading.getByRole('textbox', { name: '笔记标题', exact: true }).fill(`${title}再改名`);
  await heading.getByRole('textbox', { name: '笔记标题', exact: true }).press('Enter');
  await expect(page.getByRole('heading', { name: `${title}再改名`, exact: true })).toBeVisible();
  await expect
    .poll(async () => (await (await page.request.get(`/api/nodes/${id}`)).json()).title)
    .toBe(`${title}再改名`);
  // The note's new revision is kept, so the menu's rename does not conflict.
  await actions.getByRole('button', { name: `管理 ${title}再改名`, exact: true }).click();
  await actions.getByRole('button', { name: '重命名', exact: true }).click();
  await rename.getByLabel('标题', { exact: true }).fill(`${title}已改名`);
  await rename.getByRole('button', { name: '保存信息', exact: true }).click();
  await expect(page.getByRole('heading', { name: `${title}已改名`, exact: true })).toBeVisible();
  await actions.getByRole('button', { name: `管理 ${title}已改名`, exact: true }).click();
  await actions.getByRole('button', { name: '移动到…', exact: true }).click();
  const move = page.getByRole('dialog', { name: `移动「${title}已改名」`, exact: true });
  await move.getByRole('button', { name: destination.title, exact: true }).click();
  await move.getByRole('button', { name: '确认移动', exact: true }).click();
  await expect(move).toHaveCount(0);
  await expect
    .poll(async () => (await (await page.request.get(`/api/nodes/${id}`)).json()).parent_id)
    .toBe(destination.id);
  if (info.project.name === 'desktop') {
    // A completed move opens its destination folder and reveals the note.
    await expect(
      page
        .locator('.sidebar-tree')
        .getByRole('button', { name: `收起 ${destination.title}`, exact: true }),
    ).toBeVisible();
    const row = page
      .locator('.tree-row')
      .filter({ has: page.getByRole('button', { name: `${title}已改名`, exact: true }) });
    await expect(row).toHaveAttribute('data-tree-node', id);
    // The root target is sticky. dragTo's automatic target scrolling can move
    // a different row under the pressed pointer before Chromium starts dragging.
    await row.scrollIntoViewIfNeeded();
    const sourceBox = (await row.boundingBox())!;
    const targetBox = (await page.locator('.tree > .section-label').boundingBox())!;
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    await expect
      .poll(async () => (await (await page.request.get(`/api/nodes/${id}`)).json()).parent_id)
      .toBeNull();
  }
  await expectPreview(page);
  const note = await (await page.request.get(`/api/nodes/${id}`)).json();
  const blocked = await page.request.put(`/api/nodes/${id}/content`, {
    headers: { origin: 'http://127.0.0.1:8799' },
    data: { revision: note.revision, content: '意外写入', attachments: [] },
  });
  expect(blocked.status()).toBe(403);
  expect((await (await page.request.get(`/api/nodes/${id}`)).json()).content).toBe('');
  const storage = await (await page.request.get('/api/storage')).json();
  await nav(page, '设置', '存储空间');
  await page.getByLabel('容量上限 GB', { exact: true }).fill(String(storage.quotaBytes / 1e9 + 1));
  await page.getByRole('button', { name: '更新上限', exact: true }).click();
  await expect
    .poll(async () => (await (await page.request.get('/api/storage')).json()).quotaBytes)
    .toBe(storage.quotaBytes + 1e9);
  // A padded spelling is saved as the plain number the server stores.
  await page.getByLabel('容量上限 GB', { exact: true }).fill(`0${storage.quotaBytes / 1e9}.000`);
  await page.getByRole('button', { name: '更新上限', exact: true }).click();
  await expect
    .poll(async () => (await (await page.request.get('/api/storage')).json()).quotaBytes)
    .toBe(storage.quotaBytes);
  await expect(page.getByLabel('容量上限 GB', { exact: true })).toHaveValue(
    String(storage.quotaBytes / 1e9),
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(unlocks).toEqual([]);
});

test('reading positions resume across devices and a conflicting save preserves the draft', async ({
  page,
  context,
}, info) => {
  await login(page);
  await createNote(page, `接续阅读 · ${info.project.name}`);
  await edit(page);
  const longNote = Array.from(
    { length: 20 },
    (_, i) => `## 第 ${i + 1} 节\n\n${'这一页留给慢慢阅读的自己。'.repeat(30)}\n`,
  ).join('\n');
  await page.getByRole('textbox', { name: 'Markdown 源码' }).fill(longNote);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  const url = page.url(),
    id = url.split('/').at(-1);
  if (info.project.name === 'mobile') {
    await page.getByRole('button', { name: '标题目录', exact: true }).click();
    await page
      .getByRole('dialog', { name: '标题目录', exact: true })
      .getByRole('button', { name: '第 20 节', exact: true })
      .click();
  } else {
    await page.locator('.note-scroll').focus();
    await page.keyboard.press('End');
  }
  await expect
    .poll(async () =>
      page
        .locator('.note-scroll')
        .evaluate(
          (element) => element.scrollTop / Math.max(1, element.scrollHeight - element.clientHeight),
        ),
    )
    // End and the mobile heading jump animate; leave only after reaching the
    // requested end position, so this verifies saving that position.
    .toBeGreaterThan(0.95);
  const headings = await page
    .locator('.read-content h2')
    .evaluateAll((elements) => elements.map((element) => element.id));
  expect(new Set(headings).size).toBe(20);
  await nav(page, '收藏');
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/nodes/${id}/reading`)).json()).position.ratio || 0,
    )
    .toBeGreaterThan(0.7);
  const other = await context.newPage();
  await other.goto(url);
  await expect(other.locator('.read-content h2')).toHaveCount(20);
  await expect
    .poll(async () => other.locator('.note-scroll').evaluate((element) => element.scrollTop))
    .toBeGreaterThan(500);
  await page.goto(url);
  await edit(page);
  await edit(other);
  await writeSource(page, '设备一保存的正文');
  await writeSource(other, '设备二仍然保留的草稿');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await other.getByRole('button', { name: '保存', exact: true }).click();
  await expect(other.getByRole('alert')).toContainText('已在其他页面更新');
  await expect(other.getByRole('textbox', { name: 'Markdown 源码' })).toContainText(
    '设备二仍然保留的草稿',
  );
  // The refused text counts as a change again: its draft stays on the device.
  await expect
    .poll(() => other.evaluate((note) => localStorage.getItem(`note-draft:${note}`), id))
    .toContain('设备二仍然保留的草稿');
  // Keeping this page's text over the other one's.
  const alert = other.getByRole('alert');
  await alert.getByRole('button', { name: '用我的版本覆盖', exact: true }).click();
  await expect
    .poll(async () => (await (await other.request.get(`/api/nodes/${id}`)).json()).content)
    .toBe('设备二仍然保留的草稿');
  // A second conflict, kept beside the note instead.
  await page.reload();
  await edit(page);
  await edit(other);
  await writeSource(page, '设备一第二次保存');
  await writeSource(other, '设备二另存的内容');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect
    .poll(async () => (await (await page.request.get(`/api/nodes/${id}`)).json()).content)
    .toBe('设备一第二次保存');
  // Ctrl+S, which waits for the server, meets the same conflict.
  await other.getByRole('textbox', { name: 'Markdown 源码' }).press('ControlOrMeta+s');
  await alert.getByRole('button', { name: '另存为新笔记', exact: true }).click();
  await expect(other.locator('.cm-editor')).toHaveCount(0);
  await expect(other.locator('.read-content')).toContainText('设备一第二次保存');
  const { parent_id: parent, title } = await (await other.request.get(`/api/nodes/${id}`)).json();
  const siblings: { id: string; title: string }[] = (
    await (await other.request.get(`/api/nodes?parent=${parent ?? ''}`)).json()
  ).nodes;
  const copy = siblings.find((node) => node.title === `${title}（我的修改）`)!;
  expect((await (await other.request.get(`/api/nodes/${copy.id}`)).json()).content).toBe(
    '设备二另存的内容',
  );
  expect(await other.evaluate((note) => localStorage.getItem(`note-draft:${note}`), id)).toBeNull();
  await other.close();
});
