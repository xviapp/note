import { fetchNoteAhead } from './api';
import { isOffline } from './connectivity';
import { hasCachedNote, rememberPrefetched } from './offline-cache';
import { TEXT_KINDS, variantOf, type NoteNode } from '../shared/types';

// Notes shown in a list are fetched ahead, while the device is idle, so that
// opening one shows its text at once (useNoteLoading reads the cached copy
// first). Only the text: no files, papers or PDFs; at most PER_LIST from a
// list and PER_SESSION per launch; never offline or with data saving on. The
// copies are the cache's first to go and never make room for themselves.
const PER_LIST = 20;
const PER_SESSION = 60;
let fetched = 0;
const seen = new Set<string>();
const queue: string[] = [];
let running = false;

const saving = () =>
  !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
const idle = () =>
  new Promise<void>((resolve) =>
    'requestIdleCallback' in window
      ? requestIdleCallback(() => resolve(), { timeout: 2000 })
      : setTimeout(resolve, 200),
  );

export function prefetchNotes(nodes: NoteNode[]) {
  for (const node of nodes
    .filter((item) => TEXT_KINDS.includes(item.kind) && variantOf(item) !== 'paper')
    .slice(0, PER_LIST)) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    queue.push(node.id);
  }
  void drain();
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length && fetched < PER_SESSION) {
      await idle();
      if (isOffline() || saving()) break;
      const id = queue.shift()!;
      if (await hasCachedNote(id)) continue;
      fetched++;
      await fetchNoteAhead(id).then(rememberPrefetched).catch(() => {});
    }
  } finally {
    running = false;
  }
}

// Tests start over between cases.
export function resetPrefetch() {
  fetched = 0;
  seen.clear();
  queue.length = 0;
}
