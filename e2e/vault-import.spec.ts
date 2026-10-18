import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test } from './fixtures';
import { login } from './notebook-helpers';
import type { NoteDetail, NoteNode } from '../shared/types';
import {
  exportContentKey,
  fromBase64Url,
  keyCheck,
  newContentKey,
  newSalt,
  openBytes,
  passwordKey,
  sealedKeyId,
  wrapContentKey,
} from '../shared/encryption';

const headers = { origin: 'http://127.0.0.1:8799' };
async function writeVault(root: string, files: Record<string, string | Buffer>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

// A 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

test('imports a vault folder with its images and links', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'Folder import is offered on desktop only.');
  const vault = info.outputPath('读书库');
  await writeVault(vault, {
    '.obsidian/app.json': '{}',
    '索引.md': '# 索引\n\n见 [[读书/摘录|摘录]]。\n\n![[封面.png]]\n\n[[不存在]]\n',
    '读书/摘录.md': '回到 [索引](../索引.md)。\n',
    'attachments/封面.png': PNG,
    '读书/表格.docx': 'x',
  });
  await login(page);
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await page.getByRole('dialog', { name: '新建笔记' }).getByRole('button', { name: '导入文件夹…' }).click();
  const dialog = page.getByRole('dialog', { name: '导入文件夹' });
  await dialog.getByLabel('选择文件夹').setInputFiles(vault);
  await expect(dialog.getByText(/2 篇笔记、1 个文件、2 个文件夹/)).toBeVisible();
  await expect(dialog.getByText('跳过 1 个文件')).toBeVisible();
  await dialog.getByRole('button', { name: '开始导入' }).click();
  await expect(dialog.getByText('导入完成。')).toBeVisible();
  await expect(dialog.getByText('1 个链接未找到目标，保留原样')).toBeVisible();
  await dialog.getByRole('button', { name: '完成' }).click();

  const root = page.locator('.sidebar').getByText(/^读书库 导入 \d{4}-\d{2}-\d{2}$/);
  await expect(root).toBeVisible();
  await root.click();
  await page.locator('.main-content').getByRole('button', { name: /^索引 / }).click();
  const content = page.locator('.read-content');
  await expect(content.getByRole('heading', { name: '索引' })).toBeVisible();
  await expect(content.locator('img')).toHaveJSProperty('complete', true);
  expect(await content.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
  await expect(content.getByText('[[不存在]]')).toBeVisible();
  await content.getByRole('link', { name: '摘录' }).click();
  await expect(page.getByRole('heading', { name: '摘录', exact: true })).toBeVisible();
  await page.locator('.read-content').getByRole('link', { name: '索引' }).click();
  await expect(page.locator('.read-content').getByRole('heading', { name: '索引' })).toBeVisible();
});

test('imports into an encrypted folder, sealing every file', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'Folder import is offered on desktop only.');
  const vault = info.outputPath('私密库');
  await writeVault(vault, { '日记.md': '![](图.png)', '图.png': PNG });
  await login(page);
  const key = await newContentKey(),
    keyId = crypto.randomUUID(),
    salt = newSalt();
  const saved = await page.request.post('/api/encryption/keys', {
    headers,
    data: {
      id: keyId,
      salt,
      iterations: 100_000,
      wrapped: await wrapContentKey(await passwordKey('vault-secret', salt, 100_000), await exportContentKey(key)),
      check_value: await keyCheck(key),
    },
  });
  expect(saved.ok()).toBe(true);
  const folder: NoteNode = await (await page.request.post('/api/nodes', { headers, data: { kind: 'folder', title: '私密' } })).json();
  expect((await page.request.put(`/api/nodes/${folder.id}/encryption`, { headers, data: { encryption: keyId } })).ok()).toBe(true);
  await page.goto(`/n/${folder.id}`);
  await page.locator('.main-content').getByLabel('「私密」的密码').fill('vault-secret');
  await page.locator('.main-content').getByRole('button', { name: '解锁', exact: true }).click();
  await page.locator('.main-content').getByRole('button', { name: '新建', exact: true }).click();
  await page.getByRole('dialog', { name: '新建笔记' }).getByRole('button', { name: '导入文件夹…' }).click();
  const dialog = page.getByRole('dialog', { name: '导入文件夹' });
  await expect(dialog.getByText(/到「私密」/)).toBeVisible();
  await dialog.getByLabel('选择文件夹').setInputFiles(vault);
  await dialog.getByRole('button', { name: '开始导入' }).click();
  await expect(dialog.getByText('导入完成。')).toBeVisible();

  const [root] = (await (await page.request.get(`/api/nodes?parent=${folder.id}`)).json()).nodes as NoteNode[];
  const children = (await (await page.request.get(`/api/nodes?parent=${root.id}`)).json()).nodes as NoteNode[];
  const note = children.find((node) => node.kind === 'markdown')!,
    image = children.find((node) => node.kind === 'image')!;
  const detail: NoteDetail = await (await page.request.get(`/api/nodes/${note.id}`)).json();
  const body = new TextDecoder().decode(await openBytes(key, fromBase64Url(detail.sealed!)));
  expect(body).toBe(`![](/api/files/${image.file_blob_id})`);
  const file = new Uint8Array(await (await page.request.get(`/api/files/${image.file_blob_id}`)).body());
  expect(sealedKeyId(file)).toBe(keyId);
  await dialog.getByRole('button', { name: '完成' }).click();
  await page.goto(`/n/${note.id}`);
  await expect(page.locator('.read-content img')).toHaveJSProperty('complete', true);
  expect(await page.locator('.read-content img').evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
});
