import { expect, it } from 'vitest';
import { clearDrafts } from './note-drafts';
import { dropPhotos, keepPhoto, pendingPhotos } from './pending-photos';

it('keeps photos until sign-out, and none still being read when it happens', async () => {
  await keepPhoto('d1', 'p1', new File(['one'], '一.png', { type: 'image/png' }));
  expect((await pendingPhotos('d1')).map((photo) => photo.id)).toEqual(['p1']);
  const keeping = keepPhoto('d1', 'p2', new File(['two'], '二.png', { type: 'image/png' }));
  clearDrafts();
  await dropPhotos();
  await keeping;
  expect(await pendingPhotos('d1')).toEqual([]);
});

it('keeps no photo read in one window after another window signed out', async () => {
  const keeping = keepPhoto('d2', 'p1', new File(['one'], '一.png', { type: 'image/png' }));
  // The notebook signs out: only the shared epoch reaches this window.
  localStorage.setItem('note:draft-epoch', 'other-window');
  await dropPhotos();
  await keeping;
  expect(await pendingPhotos('d2')).toEqual([]);
});
