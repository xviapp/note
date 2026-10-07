import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';

const api = vi.fn();
const upload = vi.fn();
vi.mock('./api', async (original) => {
  const actual = await original<typeof import('./api')>();
  return {
    ...actual,
    api: (...args: unknown[]) => api(...args),
    upload: (...args: unknown[]) => upload(...args),
    cachedApi: async () => undefined,
  };
});
vi.mock('./encryption', async (original) => {
  const actual = await original<typeof import('./encryption')>();
  return { ...actual, sealString: async (keyId: string, text: string) => `sealed:${keyId}:${text}` };
});
// Each test starts from a fresh module, so the outbox is read from storage again.
const load = async () => {
  vi.resetModules();
  return import('./clips');
};
const posts = () => api.mock.calls.filter(([, method]) => method === 'POST');

describe('clip outbox', () => {
  beforeEach(() => {
    localStorage.clear();
    api.mockReset();
    upload.mockReset();
  });

  it('uploads an image first and sends the clip naming it', async () => {
    api.mockImplementation(async (path: string, method = 'GET') =>
      method === 'GET' ? { keyId: null, pinned: [], items: [], next: null } : {},
    );
    upload.mockResolvedValue({ id: 'img', name: 'shot.png', mime: 'image/png', size: 20 });
    const clips = await load();
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    const item = await clips.addClip('', null, undefined, new File([png], 'shot.png'));
    await clips.flushClips();
    expect(item.file).toEqual({ id: 'img', name: 'shot.png', mime: 'image/png', size: 20, key_id: null });
    expect(posts()[0][2]).toMatchObject({ text: '', blobId: 'img' });
    // Not a picture, or empty: nothing is uploaded.
    await expect(clips.addClip('', null, undefined, new File(['%PDF-1.4'], 'a.pdf'))).rejects.toThrow('只支持');
    await expect(clips.addClip('  ')).rejects.toThrow('请先输入内容');
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('keeps a clip written offline and sends it later under the same ID', async () => {
    api.mockImplementation(async (path: string, method = 'GET') => {
      if (method === 'GET') return { keyId: null, pinned: [], items: [], next: null };
      throw new ApiError('当前离线', 0, 'OFFLINE');
    });
    const clips = await load();
    const item = await clips.addClip('  离线时记下\r\n第二行 ', { id: 'note', title: '来源' });
    await clips.flushClips();
    expect(item.text).toBe('离线时记下\n第二行');
    // A reload finds it still waiting.
    const again = await load();
    api.mockReset();
    api.mockResolvedValue({});
    await again.flushClips();
    expect(posts()).toEqual([
      [
        '/api/clips',
        'POST',
        {
          id: item.id,
          text: '离线时记下\n第二行',
          sourceId: 'note',
          createdAt: item.createdAt,
          blobId: null,
        },
        item.id,
      ],
    ]);
    expect(localStorage.getItem('note-draft:clips')).toBeNull();
  });

  it('sends clips added while the outbox is empty or already sending', async () => {
    let release = () => {};
    api.mockImplementation(async (path: string, method = 'GET', data?: { text: string }) => {
      if (method === 'GET') return { keyId: null, pinned: [], items: [], next: null };
      if (data?.text === '一') await new Promise<void>((resolve) => (release = resolve));
      return {};
    });
    const clips = await load();
    await clips.flushClips();
    await clips.addClip('一');
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    await clips.addClip('二');
    release();
    await clips.flushClips();
    await vi.waitFor(() =>
      expect(posts().map(([, , data]) => (data as { text: string }).text)).toEqual(['一', '二']),
    );
    expect(localStorage.getItem('note-draft:clips')).toBeNull();
  });

  it('keeps a refused clip with its reason and sends the ones after it', async () => {
    api.mockImplementation(async (path: string, method = 'GET', data?: { text: string }) => {
      if (method === 'GET') return { keyId: null, pinned: [], items: [], next: null };
      if (data?.text === '太长') throw new ApiError('每条最多 10000 个字。', 413);
      return {};
    });
    const clips = await load();
    await clips.addClip('太长');
    await clips.addClip('正常');
    await clips.flushClips();
    const waiting = JSON.parse(localStorage.getItem('note-draft:clips')!);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ text: '太长', error: '每条最多 10000 个字。' });
    expect(posts().map(([, , data]) => (data as { text: string }).text)).toContain('正常');
    clips.discardPending(waiting[0].id);
    expect(localStorage.getItem('note-draft:clips')).toBeNull();
  });

  it('seals a clip again when the setting changed elsewhere', async () => {
    let key: string | null = null;
    api.mockImplementation(async (path: string, method = 'GET', data?: { text: string }) => {
      if (method === 'GET') return { keyId: key, pinned: [], items: [], next: null };
      if (!data!.text.startsWith('sealed:')) {
        key = 'k1';
        throw new ApiError('随手记的加密设置已变化，请重试。', 409, 'ENCRYPTION_CHANGED');
      }
      return {};
    });
    const clips = await load();
    await clips.addClip('秘密');
    await clips.flushClips();
    expect(posts().map(([, , data]) => (data as { text: string }).text)).toEqual([
      '秘密',
      'sealed:k1:秘密',
    ]);
    expect(localStorage.getItem('note-draft:clips')).toBeNull();
  });

  it('reloads open lists once per run and asks only for the key', async () => {
    api.mockImplementation(async (path: string, method = 'GET') => {
      if (method === 'GET') return { keyId: null, pinned: [], items: [], next: null };
      throw new ApiError('当前离线', 0, 'OFFLINE');
    });
    const clips = await load();
    await clips.addClip('一');
    await clips.addClip('二');
    await clips.flushClips();
    api.mockReset();
    api.mockResolvedValue({ keyId: null });
    const listener = vi.fn();
    const stop = clips.onClipsSent(listener);
    await clips.flushClips();
    expect(posts()).toHaveLength(2);
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    // An image needs the current key, not the list.
    upload.mockResolvedValue({ id: 'img', name: 'shot.png', mime: 'image/png', size: 20 });
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    await clips.addClip('', null, undefined, new File([png], 'shot.png'));
    expect(api.mock.calls.filter(([, method]) => !method || method === 'GET').map(([path]) => path)).toEqual([
      '/api/clips/key',
    ]);
  });
});
