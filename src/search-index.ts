import { api } from './api';
import { isOffline } from './connectivity';

// Fills the server's body search index (notes saved before it existed,
// restored backups) a few notes per request, once per launch. The scheduled
// cleanup does the same more slowly.
let started = false;
export function fillSearchIndex() {
  if (started || isOffline()) return;
  started = true;
  void (async () => {
    for (let round = 0; round < 500; round++) {
      const { indexed, more } = await api<{ indexed: number; more: boolean }>(
        '/api/search/index',
        'POST',
        {},
      );
      if (!more || !indexed) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  })().catch(() => {
    // Offline or refused: a later call (or the cleanup) carries on.
    started = false;
  });
}
