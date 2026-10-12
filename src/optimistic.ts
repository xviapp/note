import { useSyncExternalStore } from 'react';
import type { NoteNode } from '../shared/types';

// Changes shown before the server confirms them (favorite, rename, move,
// delete, create). Each listing applies them over what it loaded; when the
// change is confirmed the refreshed listing already holds it, and a failed one
// is withdrawn so the listing shows the server's state again.
interface Change {
  // Fields that differ, e.g. a new title or parent.
  fields?: Partial<NoteNode>;
  hidden?: boolean;
  // A node not loaded yet (a note being created).
  added?: NoteNode;
}
const changes = new Map<string, Change>();
// The latest copy of every node a listing has shown, so a moved one can appear in its new folder.
const known = new Map<string, NoteNode>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  listeners.forEach((listener) => listener());
};
export function useOptimisticVersion() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => version,
  );
}
export function rememberNodes(nodes: NoteNode[]) {
  for (const node of nodes) known.set(node.id, node);
}
export const knownNode = (id: string) => known.get(id);

// Shows a change at once; the returned function withdraws it.
export function showChange(id: string, change: Change) {
  changes.set(id, change);
  emit();
  return () => {
    if (changes.get(id) !== change) return;
    changes.delete(id);
    emit();
  };
}
// A confirmed change stays until the library refresh it started has landed.
export function settleChange(withdraw: () => void, delay = 5000) {
  setTimeout(withdraw, delay);
}

// A listing (see useNodeListing's queries) with the pending changes applied.
export function applyChanges(query: string, nodes: NoteNode[]): NoteNode[] {
  if (!changes.size) return nodes;
  const parent = query.startsWith('parent=') ? query.slice('parent='.length) || null : undefined;
  const favorites = query === 'view=favorites';
  const fits = (node: NoteNode) =>
    (parent === undefined || (node.parent_id ?? null) === parent) && (!favorites || !!node.favorite);
  const result: NoteNode[] = [];
  for (const node of nodes) {
    const change = changes.get(node.id);
    if (change?.hidden) continue;
    const next = change?.fields ? { ...node, ...change.fields } : node;
    if (fits(next)) result.push(next);
  }
  // Moved here, favorited, or being created: shown at the end until the refresh.
  if (parent !== undefined || favorites)
    for (const [id, change] of changes) {
      if (change.hidden || result.some((node) => node.id === id)) continue;
      const base = change.added ?? known.get(id);
      if (!base) continue;
      const next = { ...base, ...change.fields };
      // Only a move (into a folder) or a favorite (into 收藏) adds a node to a list;
      // a new title alone never does.
      const arrives = !!change.added
        || (parent !== undefined && change.fields?.parent_id !== undefined)
        || (favorites && change.fields?.favorite !== undefined);
      if (arrives && fits(next)) result.push(next);
    }
  return result;
}
