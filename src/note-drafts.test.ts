import { beforeEach, expect, it, vi } from 'vitest';
import { clearDrafts, DRAFT_PREFIX, removeDraft, writeDraft } from './note-drafts';

const { seal } = vi.hoisted(() => ({ seal: vi.fn() }));
vi.mock('./keyring', () => ({ unlockedKey: async () => ({}) }));
vi.mock('../shared/encryption', () => ({ sealText: seal }));
beforeEach(() => { localStorage.clear(); seal.mockReset(); });

it('keeps the newest encrypted draft when encryption finishes out of order', async () => {
  let finish!: (value: string) => void;
  seal.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce('newest-ciphertext');
  const draft = { content: 'old', attachments: [], revision: 1, savedAt: 1 };
  const old = writeDraft('race', draft, 'key');
  await Promise.resolve();
  await writeDraft('race', { ...draft, content: 'new' }, 'key');
  finish('old-ciphertext');
  await old;
  expect(JSON.parse(localStorage.getItem(`${DRAFT_PREFIX}race`)!)).toEqual({ sealed: 'newest-ciphertext' });
});

it.each(['remove', 'sign-out'])('does not resurrect a draft after %s when encryption finishes', async (action) => {
  let finish!: (value: string) => void;
  seal.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
  const writing = writeDraft('removed', { content: 'text', attachments: [], revision: 1, savedAt: 1 }, 'key');
  await Promise.resolve();
  if (action === 'remove') removeDraft('removed');
  else clearDrafts();
  finish('ciphertext');
  await writing;
  expect(localStorage.getItem(`${DRAFT_PREFIX}removed`)).toBeNull();
});
