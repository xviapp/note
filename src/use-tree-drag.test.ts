import { beforeEach, describe, expect, it } from 'vitest';
import { dropTarget, ghostTransform, ROOT_TARGET } from './use-tree-drag';

// root > [section label] + Outer > Inner, Note (top level)
function tree() {
  document.body.innerHTML = `
    <div id="tree">
      <div class="section-label" data-tree-root><span id="label">我的笔记</span></div>
      <ul>
        <li data-tree-item="outer">
          <div data-tree-node="outer" data-tree-container="true"><span id="outer">Outer</span></div>
          <ul>
            <li data-tree-item="inner">
              <div data-tree-node="inner" data-tree-container="true"><span id="inner">Inner</span></div>
            </li>
          </ul>
        </li>
        <li data-tree-item="note">
          <div data-tree-node="note" data-tree-container="true"><span id="note">Note</span></div>
        </li>
        <li data-tree-item="link">
          <div data-tree-node="link"><span id="link">Link</span></div>
        </li>
      </ul>
    </div>
    <p id="outside">outside</p>`;
  return document.getElementById('tree')!;
}
const at = (id: string) => document.getElementById(id);

describe('dropTarget', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = tree();
  });
  it('accepts a container row, from anywhere inside it', () => {
    expect(dropTarget(at('outer'), root, { id: 'note', parent_id: null })).toBe('outer');
    expect(dropTarget(at('inner'), root, { id: 'note', parent_id: null })).toBe('inner');
  });
  it('rejects rows that cannot hold children and points outside the tree', () => {
    expect(dropTarget(at('link'), root, { id: 'note', parent_id: null })).toBeUndefined();
    expect(dropTarget(at('outside'), root, { id: 'note', parent_id: null })).toBeUndefined();
    expect(dropTarget(null, root, { id: 'note', parent_id: null })).toBeUndefined();
  });
  it('rejects the current parent, the node itself and anything beneath it', () => {
    expect(dropTarget(at('outer'), root, { id: 'inner', parent_id: 'outer' })).toBeUndefined();
    expect(dropTarget(at('outer'), root, { id: 'outer', parent_id: null })).toBeUndefined();
    expect(dropTarget(at('inner'), root, { id: 'outer', parent_id: null })).toBeUndefined();
  });
  it('offers the top level only to nodes that are not already there', () => {
    expect(dropTarget(at('label'), root, { id: 'inner', parent_id: 'outer' })).toBe(ROOT_TARGET);
    expect(dropTarget(at('label'), root, { id: 'note', parent_id: null })).toBeUndefined();
  });
});

describe('ghostTransform', () => {
  it('keeps the card above a finger and beside a cursor', () => {
    expect(ghostTransform(100, 200, 'touch')).toBe('translate3d(72px, 136px, 0)');
    expect(ghostTransform(100, 200, 'mouse')).toBe('translate3d(114px, 210px, 0)');
  });
});
