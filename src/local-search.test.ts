import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteDetail } from '../shared/types';

vi.mock('./offline-cache', () => ({ cachedSealedNotes: vi.fn() }));
vi.mock('./encryption', () => ({ reveal: vi.fn() }));
vi.mock('./keyring', () => ({ isUnlocked: vi.fn(), subscribeKeys: vi.fn() }));
const { cachedSealedNotes } = await import('./offline-cache');
const { reveal } = await import('./encryption');
const { isUnlocked } = await import('./keyring');
const { searchEncryptedBodies } = await import('./local-search');

const note = (id: string, keyId: string, body: string, updated = 1) =>
  ({
    id,
    kind: 'markdown',
    title: `sealed-title-${id}`,
    key_id: keyId,
    revision: 1,
    updated_at: updated,
    sealed: `sealed:${body}`,
    content: '',
    attachments: [],
    breadcrumbs: [
      { id: 'folder', title: 'sealed-folder' },
      { id, title: `sealed-title-${id}` },
    ],
  }) as unknown as NoteDetail;

describe('searching encrypted bodies on this device', () => {
  beforeEach(() => {
    vi.mocked(reveal).mockReset();
    // Opening replaces sealed values: the body from `sealed`, titles by name.
    vi.mocked(reveal).mockImplementation(async (value) => {
      const text = JSON.stringify(value).replace(/sealed-/g, '');
      const out = JSON.parse(text) as Record<string, unknown>;
      if (typeof out.sealed === 'string') out.content = (out.sealed as string).slice('sealed:'.length);
      return out as never;
    });
  });

  it('finds unlocked notes by every word, with context and opened titles', async () => {
    vi.mocked(cachedSealedNotes).mockResolvedValue([
      note('a', 'k1', '# 日记\n\n今天读了 **Attention** 论文，很有启发。', 2),
      note('b', 'k2', '锁着的 Attention 笔记'),
      note('c', 'k1', '没有关键词'),
    ]);
    vi.mocked(isUnlocked).mockImplementation((id) => id === 'k1');
    const found = await searchEncryptedBodies(['attention', '论文']);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      id: 'a',
      title: 'title-a',
      path: ['folder'],
      local: true,
      excerpt: '日记 今天读了 Attention 论文，很有启发。',
    });
    expect(found[0]).not.toHaveProperty('content');
    expect(found[0]).not.toHaveProperty('sealed');
  });

  it('opens each body once per revision', async () => {
    vi.mocked(cachedSealedNotes).mockResolvedValue([note('d', 'k1', '缓存的正文')]);
    vi.mocked(isUnlocked).mockReturnValue(true);
    await searchEncryptedBodies(['缓存']);
    await searchEncryptedBodies(['正文']);
    // One full opening, plus the title and path for each match.
    const bodies = vi.mocked(reveal).mock.calls.filter(([value]) => 'sealed' in (value as object));
    expect(bodies).toHaveLength(1);
  });
});
