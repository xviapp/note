import { useSyncExternalStore, type MouseEvent } from 'react';
import { Capacitor } from '@capacitor/core';
import type { NoteNode } from '../shared/types';
import { knownNode } from './optimistic';

// Selecting several notes on desktop: Ctrl (⌘ on macOS) + click adds or
// removes one, Shift + click selects every row shown between the last clicked
// one and this one. The sidebar tree and a folder's list ('tree', 'list') each
// have their own selection; selecting in one clears the other.
//
// Rows carry data-select-id; the element around a row and its children carries
// data-select-item (so its ancestors can be found), and the list or tree as a
// whole carries data-select-scope (so a range follows the rows as shown).
export type SelectionScope = 'tree' | 'list';
export interface Selected {
  node: NoteNode;
  // Selectable rows it sits inside, nearest first, when it was selected.
  ancestors: string[];
}
interface Selection {
  scope: SelectionScope | null;
  items: Map<string, Selected>;
  // The row a range starts from: the last one clicked in the scope. `opened`
  // when a plain click opened it and nothing was selected since.
  anchor: { id: string; scope: SelectionScope; opened?: boolean } | null;
}
let state: Selection = { scope: null, items: new Map(), anchor: null };
const listeners = new Set<() => void>();
function set(next: Selection) {
  state = next;
  listeners.forEach((listener) => listener());
}
export function useSelection() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => state,
  );
}
export const selection = () => state;
export const isSelected = (id: string) => state.items.has(id);
export function clearSelection() {
  if (state.items.size) set({ scope: null, items: new Map(), anchor: state.anchor && { ...state.anchor, opened: false } });
}

// Desktop browsers only: phones and the Android app have no modifier keys.
export const canMultiSelect = () =>
  !Capacitor.isNativePlatform() && !window.matchMedia?.('(pointer: coarse)').matches;
const mac = () => /Mac|iPhone|iPad/.test(navigator.platform);

function ancestorsOf(row: Element): string[] {
  const found: string[] = [];
  let item = row.closest('[data-select-item]')?.parentElement?.closest<HTMLElement>('[data-select-item]');
  for (; item; item = item.parentElement?.closest<HTMLElement>('[data-select-item]'))
    found.push(item.dataset.selectItem!);
  return found;
}
function entry(row: Element | null | undefined, id: string, fallback?: NoteNode): Selected | null {
  const node = (id === fallback?.id ? fallback : undefined) ?? knownNode(id);
  return node ? { node, ancestors: row ? ancestorsOf(row) : [] } : null;
}

// Handles a click on a row. Returns true when it selected instead of opening;
// a plain click returns false (the row opens) and clears the selection.
export function selectClick(event: MouseEvent, node: NoteNode, scope: SelectionScope): boolean {
  const toggle = mac() ? event.metaKey : event.ctrlKey;
  if ((!toggle && !event.shiftKey) || !canMultiSelect() || node.id.startsWith('pending-')) {
    set({ scope: null, items: new Map(), anchor: { id: node.id, scope, opened: true } });
    return false;
  }
  event.preventDefault();
  const row = (event.currentTarget as Element).closest('[data-select-id]');
  const root = row?.closest('[data-select-scope]');
  const anchor = state.anchor?.scope === scope ? state.anchor.id : null;
  const items = new Map(state.scope === scope ? state.items : []);
  // The note just opened joins the first Ctrl + click, as in a file manager.
  if (!items.size && anchor && state.anchor?.opened && anchor !== node.id && !event.shiftKey) {
    const opened = root?.querySelector(`[data-select-id="${CSS.escape(anchor)}"]`);
    const value = opened && entry(opened, anchor);
    if (value) items.set(anchor, value);
  }
  if (event.shiftKey) {
    const rows = [...(root?.querySelectorAll<HTMLElement>('[data-select-id]') ?? [])];
    const ids = rows.map((element) => element.dataset.selectId!);
    const to = ids.indexOf(node.id),
      from = anchor ? ids.indexOf(anchor) : -1;
    // Shift alone replaces the selection with the range; with Ctrl it adds to it.
    if (!toggle) items.clear();
    const [start, end] = from < 0 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
    for (let index = start; index <= end; index++) {
      const value = entry(rows[index], ids[index], node);
      if (value && !ids[index].startsWith('pending-')) items.set(ids[index], value);
    }
    set({ scope, items, anchor: state.anchor?.scope === scope ? { ...state.anchor, opened: false } : { id: node.id, scope } });
    return true;
  }
  if (items.has(node.id)) items.delete(node.id);
  else {
    const value = entry(row, node.id, node);
    if (value) items.set(node.id, value);
  }
  set({ scope: items.size ? scope : null, items, anchor: { id: node.id, scope } });
  return true;
}

// What a batch action works on: a row inside another selected row goes with it.
export function topSelected(items = state.items): NoteNode[] {
  return [...items.values()]
    .filter(({ node, ancestors }) =>
      !ancestors.some((id) => items.has(id)) && !(node.parent_id && items.has(node.parent_id)))
    .map(({ node }) => node);
}
