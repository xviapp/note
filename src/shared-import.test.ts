import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  importShare,
  incomingShareTitle,
  incomingShareFilePath,
  type IncomingShare,
} from './shared-import';

const mocks = vi.hoisted(() => ({ api: vi.fn(), upload: vi.fn() }));
vi.mock('./api', () => mocks);
const id = '11111111-1111-4111-8111-111111111111';
const fileId = '22222222-2222-4222-8222-222222222222';
const body = 'AI 回答\n\n# 阅读\n\n**答案**\n\n——\n书名：阅读之书\n作者：作者甲\n讨论：章节问题';
const share: IncomingShare = { id, title: '章节问题', text: body, files: [] };
const image = {
  id: fileId,
  name: '阅读之书-第 12 页-第一节.jpg',
  mime: 'image/jpeg',
  size: 4,
  path: `/__share/${id}/${fileId}`,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  mocks.api.mockResolvedValue({ id: 'note', kind: 'markdown' });
});

describe('incoming Android shares', () => {
  it('uses the subject, filename or first nonblank heading as the editable title', () => {
    expect(incomingShareTitle(share)).toBe('章节问题');
    expect(incomingShareTitle({ id, files: [image] })).toBe('阅读之书-第 12 页-第一节');
    expect(incomingShareTitle({ id, title: ' ', text: '\n\n# 摘录标题\r\n正文', files: [] })).toBe(
      '摘录标题',
    );
    expect(incomingShareTitle({ id, files: [] })).toBe('分享内容');
    expect(incomingShareTitle({ ...share, title: '字'.repeat(300) })).toHaveLength(200);
  });
  it('keeps AI Markdown and provenance intact and uses deterministic retry keys', async () => {
    await importShare(share, { title: '我的标题', text: body, parent: 'folder' }, vi.fn());
    expect(mocks.api).toHaveBeenCalledWith(
      '/api/nodes',
      'POST',
      {
        kind: 'markdown',
        title: '我的标题',
        content: body,
        parentId: 'folder',
      },
      `share-text-${id}`,
    );
    await importShare(share, { title: '我的标题', text: body, parent: 'folder' }, vi.fn());
    expect(mocks.api.mock.calls[0]?.[3]).toBe(mocks.api.mock.calls[1]?.[3]);
  });
  it('keeps pure URL imports as links', async () => {
    await importShare(
      share,
      { title: '链接', text: 'https://example.com/book', parent: null },
      vi.fn(),
    );
    expect(mocks.api).toHaveBeenCalledWith(
      '/api/nodes',
      'POST',
      { kind: 'link', title: '链接', parentId: null, url: 'https://example.com/book' },
      `share-text-${id}`,
    );
  });
  it('copies the received image into note storage after confirmation', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4])));
    vi.stubGlobal('fetch', fetch);
    mocks.upload.mockResolvedValue({ id: 'upload', mime: 'image/jpeg' });
    mocks.api.mockResolvedValue({ id: 'note', kind: 'image', file_blob_id: 'upload' });
    await importShare({ id, files: [image] }, { title: '书页', text: '', parent: null }, vi.fn());
    expect(fetch).toHaveBeenCalledWith(image.path);
    expect(mocks.upload.mock.calls[0]?.[0]).toMatchObject({
      name: image.name,
      type: image.mime,
      size: 4,
    });
    expect(mocks.api).toHaveBeenCalledWith(
      '/api/nodes',
      'POST',
      { kind: 'image', title: '书页', parentId: null, fileId: 'upload' },
      `share-file-${fileId}`,
    );
  });
  it('validates all file paths and types before any network mutation', async () => {
    expect(() =>
      incomingShareFilePath({ id, files: [] }, { ...image, path: `/__share/${fileId}/${fileId}` }),
    ).toThrow('地址无效');
    expect(() => incomingShareFilePath({ id, files: [] }, { ...image, mime: 'text/html' })).toThrow(
      '格式',
    );
    expect(() => incomingShareFilePath({ id, files: [] }, { ...image, size: -1 })).toThrow('大小');
    await expect(
      importShare(
        { id, files: [image, { ...image, path: 'https://attacker.test/file' }] },
        { title: '书页', text: '', parent: null },
        vi.fn(),
      ),
    ).rejects.toThrow('地址无效');
    expect(mocks.api).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it('rejects empty, errored and incomplete payloads without creating notes', async () => {
    await expect(
      importShare(share, { title: ' ', text: body, parent: null }, vi.fn()),
    ).rejects.toThrow('标题');
    await expect(
      importShare(share, { title: '标题', text: '', parent: null }, vi.fn()),
    ).rejects.toThrow('为空');
    await expect(
      importShare(
        { ...share, error: '读取失败' },
        { title: '标题', text: body, parent: null },
        vi.fn(),
      ),
    ).rejects.toThrow('读取失败');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1]))));
    await expect(
      importShare({ id, files: [image] }, { title: '图片', text: '', parent: null }, vi.fn()),
    ).rejects.toThrow('不完整');
    expect(mocks.api).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
