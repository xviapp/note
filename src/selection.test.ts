import { beforeEach, expect, it } from 'vitest';
import type { MouseEvent } from 'react';
import type { NoteNode } from '../shared/types';
import { rememberNodes } from './optimistic';
import { clearSelection, selectClick, selection, topSelected } from './selection';

const node = (id: string, parent: string | null = null) => ({ id, parent_id: parent, title: id }) as NoteNode;
// a, b (holding b1), c, as rendered by the tree.
const nodes = [node('a'), node('b'), node('b1', 'b'), node('c')];
let root: HTMLElement;
beforeEach(() => {
  clearSelection();
  rememberNodes(nodes);
  document.body.innerHTML = `<div data-select-scope="tree">
    <div data-select-item="a"><div data-select-id="a"><button id="a"></button></div></div>
    <div data-select-item="b"><div data-select-id="b"><button id="b"></button></div>
      <div data-select-item="b1"><div data-select-id="b1"><button id="b1"></button></div></div></div>
    <div data-select-item="c"><div data-select-id="c"><button id="c"></button></div></div>
  </div>`;
  root = document.body;
});
const click = (id: string, keys: { ctrlKey?: boolean; shiftKey?: boolean } = {}) =>
  selectClick(
    { ctrlKey: false, metaKey: false, shiftKey: false, ...keys, currentTarget: root.querySelector(`#${id}`)!, preventDefault() {} } as unknown as MouseEvent,
    nodes.find((item) => item.id === id)!,
    'tree',
  );
const chosen = () => [...selection().items.keys()];

it('opens on a plain click and selects with Ctrl, taking the opened row along', () => {
  expect(click('a')).toBe(false);
  expect(chosen()).toEqual([]);
  expect(click('c', { ctrlKey: true })).toBe(true);
  expect(chosen()).toEqual(['a', 'c']);
  click('a', { ctrlKey: true });
  expect(chosen()).toEqual(['c']);
  // A plain click opens and clears the selection.
  expect(click('b')).toBe(false);
  expect(chosen()).toEqual([]);
});

it('selects the rows shown between the anchor and Shift + click', () => {
  click('a');
  click('b1', { shiftKey: true });
  expect(chosen()).toEqual(['a', 'b', 'b1']);
  // The range is redrawn from the same anchor; Ctrl + Shift adds to it.
  click('b', { shiftKey: true });
  expect(chosen()).toEqual(['a', 'b']);
  click('c', { ctrlKey: true });
  click('c', { ctrlKey: true, shiftKey: true });
  expect(chosen()).toEqual(['a', 'b', 'c']);
});

it('acts on a row only once when its ancestor is selected too', () => {
  click('b');
  click('b1', { ctrlKey: true });
  click('c', { ctrlKey: true });
  expect(chosen()).toEqual(['b', 'b1', 'c']);
  expect(topSelected().map((item) => item.id)).toEqual(['b', 'c']);
});

it('keeps the tree and a list apart', () => {
  click('a');
  click('c', { ctrlKey: true });
  selectClick(
    { ctrlKey: true, metaKey: false, shiftKey: false, currentTarget: root.querySelector('#b')!, preventDefault() {} } as unknown as MouseEvent,
    nodes[1],
    'list',
  );
  expect(selection().scope).toBe('list');
  expect(chosen()).toEqual(['b']);
});

it('does not take a row along after the selection was cleared', () => {
  click('a');
  click('b', { ctrlKey: true });
  clearSelection();
  click('c', { ctrlKey: true });
  expect(chosen()).toEqual(['c']);
});
