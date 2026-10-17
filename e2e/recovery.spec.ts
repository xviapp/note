import { test, expect, type APIResponse } from './fixtures';
import { login } from './notebook-helpers';
import type { FileInfo, NoteDetail, NoteNode } from '../shared/types';
import {
  exportContentKey,
  fromBase64Url,
  keyCheck,
  newContentKey,
  newSalt,
  openBytes,
  passwordKey,
  sealBytes,
  wrapContentKey,
} from '../shared/encryption';

const headers = { origin: 'http://127.0.0.1:8799' };
test.use({ serviceWorkers: 'block' });

async function checked<T>(request: Promise<APIResponse>): Promise<T> {
  const response = await request;
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

for (const theme of ['light', 'dark', 'starry']) {
  test(`recovers from a failed editor import in the ${theme} theme`, async ({ page }, info) => {
    await login(page);
    const note = await checked<NoteNode>(page.request.post('/api/nodes', {
      headers,
      data: { kind: 'markdown', title: '异常恢复测试', content: '云端正文保留。' },
    }));
    await page.evaluate((value) => localStorage.setItem('note:theme', value), theme);
    await page.route('**/Editor-*.js', (route) => route.abort());
    await page.goto(`/n/${note.id}`);
    await expect(page.locator('.read-content')).toContainText('云端正文保留。');
    await page.getByRole('button', { name: '编辑正文', exact: true }).click();
    await expect(page.getByRole('heading', { name: '页面遇到问题' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.getByText('错误详情', { exact: true }).click();
    await expect(page.locator('.app-error-card pre')).toContainText('页间');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/recovery-${theme}-${info.project.name}.png` });
    await page.getByRole('link', { name: '回到首页' }).click();
    await expect(page.locator('.app-shell')).toBeVisible();
    await page.unroute('**/Editor-*.js');
    await page.goto(`/n/${note.id}`);
    await expect(page.locator('.read-content')).toContainText('云端正文保留。');
    await page.getByRole('button', { name: '编辑正文', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Markdown 源码' })).toBeVisible();
  });
}

test('restores an encrypted ZIP backup and repairs its attachment and note links', async ({ page }) => {
  await login(page);
  const key = await newContentKey();
  const keyId = crypto.randomUUID();
  const salt = newSalt();
  const record = {
    id: keyId,
    salt,
    iterations: 100_000,
    wrapped: await wrapContentKey(
      await passwordKey('backup-secret', salt, 100_000),
      await exportContentKey(key),
    ),
    check_value: await keyCheck(key),
  };
  await checked(page.request.post('/api/encryption/keys', { headers, data: record }));
  const folder = await checked<NoteNode>(page.request.post('/api/nodes', {
    headers,
    data: { kind: 'folder', title: '私密资料' },
  }));
  await checked(page.request.put(`/api/nodes/${folder.id}/encryption`, {
    headers,
    data: { encryption: keyId },
  }));
  const upload = async (text: string): Promise<FileInfo> => {
    const sealed = await sealBytes(key, keyId, new TextEncoder().encode(text));
    return checked<FileInfo>(page.request.post(
      `/api/files?name=private.txt&size=${sealed.length}&key=${keyId}&mime=text%2Fplain`,
      {
        headers: { ...headers, 'content-type': 'application/octet-stream' },
        data: Buffer.from(sealed),
      },
    ));
  };
  const attachment = await upload('附件中的秘密');
  const content = `私密正文\n\n[附件](/api/files/${attachment.id})\n\n[资料目录](/n/${folder.id})`;
  const body = await upload(content);
  const note = await checked<NoteNode>(page.request.post('/api/nodes', {
    headers,
    data: {
      kind: 'markdown',
      title: '私密笔记',
      parentId: folder.id,
      bodyBlobId: body.id,
      attachments: [attachment.id],
    },
  }));

  await page.goto('/settings/backup');
  // Exercise the ZIP download path without opening the browser's save picker.
  await page.evaluate(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出整库备份' }).click();
  const archive = await download;
  await expect(page.getByText('备份已保存。', { exact: true })).toBeVisible();
  await page.getByLabel('选择备份文件', { exact: true }).setInputFiles((await archive.path())!);
  await page.getByRole('button', { name: '恢复到新目录', exact: true }).click();
  const committed = page.waitForResponse((response) =>
    /\/api\/backups\/[^/]+\/commit$/.test(response.url()),
  );
  await page.getByRole('dialog', { name: '恢复这份备份？' })
    .getByRole('button', { name: '恢复到新目录' }).click();
  const { mapping } = await checked<{ mapping: Record<string, string> }>(committed);
  const unlock = page.locator('.backup-preview .unlock-form');
  await unlock.getByLabel('密码', { exact: true }).fill('wrong-password');
  await unlock.getByRole('button', { name: '解锁', exact: true }).click();
  await expect(unlock.getByRole('alert')).toBeVisible();
  await unlock.getByLabel('密码', { exact: true }).fill('backup-secret');
  await unlock.getByRole('button', { name: '解锁', exact: true }).click();
  await expect(unlock.getByLabel('密码', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '修复加密内容' }).click();
  await expect(page.getByText('已恢复，加密内容中的附件和链接已修复。', { exact: true })).toBeVisible();

  const detail = await checked<NoteDetail>(page.request.get(`/api/nodes/${mapping[note.id]}`));
  const opened = new TextDecoder().decode(await openBytes(key, fromBase64Url(detail.sealed!)));
  expect(opened).toBe(
    `私密正文\n\n[附件](/api/files/${mapping[attachment.id]})\n\n[资料目录](/n/${mapping[folder.id]})`,
  );
  const file = await page.request.get(`/api/files/${mapping[attachment.id]}`);
  expect(file.ok()).toBe(true);
  expect(new TextDecoder().decode(await openBytes(key, new Uint8Array(await file.body())))).toBe('附件中的秘密');
  const original = await checked<NoteDetail>(page.request.get(`/api/nodes/${note.id}`));
  expect(new TextDecoder().decode(await openBytes(key, fromBase64Url(original.sealed!)))).toBe(content);
});
