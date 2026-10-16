import { cachedSealedNotes } from './offline-cache';
import { reveal } from './encryption';
import { isUnlocked, subscribeKeys } from './keyring';
import { excerptAt, searchText } from '../shared/search-text';
import { SEARCH_LIMIT, type SearchResult } from '../shared/types';
import { compareSearch, matchesSearchType, type SearchOptions } from '../shared/search';

// Encrypted notes are not in the server's search index (worker/note-text.ts):
// their bodies are searched here, among the notes this device has cached and
// whose key is unlocked. Opened text stays in memory for this page only.
const opened = new Map<string, { revision: number; text: string }>();

export async function searchEncryptedBodies(words: string[], options: SearchOptions = {}): Promise<SearchResult[]> {
  const lower = words.map((word) => word.toLowerCase());
  const found: SearchResult[] = [];
  for (const note of await cachedSealedNotes()) {
    if (!matchesSearchType(note, options.type) || (options.parent && !note.breadcrumbs.slice(0, -1).some((part) => part.id === options.parent))) continue;
    if (!isUnlocked(note.key_id!)) continue;
    let entry = opened.get(note.id);
    if (entry?.revision !== note.revision) {
      const open = await reveal(note).catch(() => null);
      if (!open || open.locked) continue;
      entry = { revision: note.revision, text: searchText(open.kind, open.content) };
      opened.set(note.id, entry);
    }
    const haystack = entry.text.toLowerCase();
    if (!lower.every((word) => haystack.includes(word))) continue;
    const at = haystack.indexOf(lower[0]!);
    // Titles and the path may be sealed too; the body is not opened again.
    const { content: _content, attachments: _attachments, file: _file, sealed: _sealed, ...rest } = note;
    const { breadcrumbs, ...node } = await reveal(rest);
    found.push({
      ...node,
      path: breadcrumbs.slice(0, -1).map((crumb) => crumb.title),
      ancestor_ids: breadcrumbs.slice(0, -1).map((crumb) => crumb.id),
      excerpt: excerptAt(entry.text, at, lower[0]!.length),
      local: true,
    });
  }
  return found.sort((a, b) => compareSearch(a, b, words, options.sort)).slice(0, SEARCH_LIMIT);
}
// Locking a key (or signing out) leaves nothing opened behind.
subscribeKeys(() => opened.clear());
