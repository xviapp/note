import { expect, test } from './fixtures';
import { expectPreview, login, createNote, edit } from './notebook-helpers';

test('Android back dismisses reading surfaces and protects unsaved files', async ({
  page,
}, info) => {
  const back = (canGoBack = false) =>
    page.evaluate(
      (value) =>
        window.dispatchEvent(
          new CustomEvent('note:native-back', {
            cancelable: true,
            detail: { canGoBack: value },
          }),
        ),
      canGoBack,
    );
  await login(page);
  await createNote(page, `Android 返回 · ${info.project.name}`);
  const noteUrl = page.url();
  await edit(page);
  await page.getByRole('textbox', { name: 'Markdown 源码' }).fill('# 未保存的手机草稿');
  expect(await back(true)).toBe(false);
  await expect(page.getByRole('dialog', { name: '还有未保存的修改' })).toBeVisible();
  expect(await back()).toBe(false);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Markdown 源码' })).toContainText(
    '未保存的手机草稿',
  );
  expect(page.url()).toBe(noteUrl);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expectPreview(page);

  await page.getByRole('button', { name: '打开青藜', exact: true }).click();
  const assistant = page.getByRole('complementary', { name: '青藜', exact: true });
  if (info.project.name === 'desktop') {
    await assistant.getByRole('button', { name: '最大化青藜', exact: true }).click();
    expect(await back()).toBe(false);
    await expect(assistant).toBeVisible();
    await expect(assistant).not.toHaveClass(/assistant-maximized/);
  }
  expect(await back()).toBe(false);
  await expect(assistant).toBeHidden();
  expect(page.url()).toBe(noteUrl);

  if (info.project.name === 'mobile') {
    await page.getByRole('button', { name: '打开笔记目录', exact: true }).click();
    expect(await back()).toBe(false);
    await expect(page.getByRole('button', { name: '关闭侧栏', exact: true })).toHaveCount(0);
  }
  expect(await back()).toBe(false);
  await expect(page).toHaveURL('/');
  expect(await back()).toBe(true);
});
