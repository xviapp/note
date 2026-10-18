import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, CornerLeftUp, MoreHorizontal, Plus, RefreshCw } from 'lucide-react';
import { api } from '../api';
import type { NoteNode } from '../../shared/types';
import { EmptyDirectory, NodeIcon, Spinner } from './Primitives';
import { OfflineSaveButton } from './OfflineCache';
import { useNodeListing, type NodeListing as Listing } from '../use-node-listing';
import { useOffline } from '../connectivity';
import { ghostTransform, ROOT_TARGET, useTreeDrag, type TreeDrag } from '../use-tree-drag';
import { noteType } from '../note-types/registry';
import { LockBadge, useKeys } from './LockBadge';
import { isUnlocked, lock } from '../keyring';
import { nodeDescription, useListPreferences, type ListSort } from '../list-preferences';
import { ListControls } from './ListControls';
import { canMultiSelect, selectClick, selection, topSelected, useSelection } from '../selection';

export type NodeAction = 'rename' | 'move' | 'delete' | 'new' | 'icon' | 'encryption';
export interface TreeProps {
  browsing?: boolean;
  listSort?: ListSort;
  onNew?: () => void;
  expansionState?: Set<string>;
  showRefresh?: boolean;
  refresh: number;
  onRefresh: () => Promise<void>;
  selected: string | null;
  onOpen: (node: NoteNode) => void;
  onAction: (action: NodeAction, node: NoteNode) => void;
  // Resolves once the move is saved (true) or rejected (false).
  onDrop: (id: string, parent: string | null, parentTitle: string) => Promise<boolean>;
  // Selected notes dragged together (see src/selection.ts).
  onDropMany?: (nodes: NoteNode[], parent: string | null, parentTitle: string) => Promise<unknown>;
  // A completed move to reveal: the tree opens its folder and highlights it.
  moved?: MovedNode | null;
}
// `path` lists the destination's ancestors from the top level down, when known,
// so a destination inside collapsed folders can still be revealed.
export type MovedNode = { id: string; parent: string | null; key: number; path?: string[] };
type DragView = {
  drag: TreeDrag | null;
  saving?: string;
  landed: { id: string; parent: string | null } | null;
  reveal: Set<string>;
  start: Pick<ReturnType<typeof useTreeDrag>, 'startMouse' | 'startTouch'>;
  expandListeners: Set<(id: string) => void>;
};
const DragContext = createContext<DragView | null>(null);
export function NodeMenu({
  node,
  onAction,
  children,
}: {
  node: NoteNode;
  onAction: TreeProps['onAction'];
  // Extra items, e.g. toolbar actions that move into the menu on phones.
  children?: ReactNode;
}) {
  useKeys();
  return (
    <details className="node-menu" name="node-actions">
      <summary role="button" className="icon-button" aria-label={`管理 ${node.title}`}>
        <MoreHorizontal size={18} />
      </summary>
      <div className="menu-popup">
        {children}
        <OfflineSaveButton node={node} />
        {noteType(node).newChild && <button onClick={() => onAction('new', node)}>新建笔记</button>}
        <button onClick={() => onAction('rename', node)}>
          重命名{node.kind === 'link' && !node.arxiv_id ? ' / 修改链接' : ''}
        </button>
        {noteType(node).customIcon && (
          <button onClick={() => onAction('icon', node)}>更换图标</button>
        )}
        <button onClick={() => onAction('move', node)}>移动到…</button>
        <button onClick={() => onAction('encryption', node)}>本地加密</button>
        {node.key_id && isUnlocked(node.key_id) && (
          <button
            onClick={(event) => {
              event.currentTarget.closest('details')!.open = false;
              lock(node.key_id!);
            }}
          >
            立即锁定
          </button>
        )}
        <button className="danger-text" onClick={() => onAction('delete', node)}>
          移到回收站
        </button>
      </div>
    </details>
  );
}
function Branch({
  parent,
  depth = 0,
  onLoading,
  ...props
}: TreeProps & {
  parent: string | null;
  depth?: number;
  onLoading: (request: symbol, loading: boolean) => void;
}) {
  const { listing, error, loading, more } = useNodeListing(`parent=${parent || ''}${props.listSort && props.listSort !== 'default' ? `&sort=${props.listSort}` : ''}`, props.refresh);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    if (props.expansionState) return new Set(props.expansionState);
    try {
      return new Set(JSON.parse(sessionStorage.getItem('expanded-nodes') || '[]'));
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    if (!loading) return;
    const request = Symbol();
    onLoading(request, true);
    return () => onLoading(request, false);
  }, [loading, onLoading]);
  const view = useContext(DragContext);
  const chosen = useSelection();
  // Each change is applied to the saved set rather than written from this
  // Branch's copy, so Branches do not overwrite each other's expansions.
  const setOpen = (id: string, open: boolean) => {
    if (props.expansionState) {
      if (open) props.expansionState.add(id);
      else props.expansionState.delete(id);
    }
    try {
      const saved = new Set<string>(JSON.parse(sessionStorage.getItem('expanded-nodes') || '[]'));
      if (open) saved.add(id);
      else saved.delete(id);
      sessionStorage.setItem('expanded-nodes', JSON.stringify([...saved]));
    } catch {
      /* Optional UI preference. */
    }
    setExpanded((previous) => {
      if (previous.has(id) === open) return previous;
      const next = new Set(previous);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const toggle = (id: string) => setOpen(id, !expanded.has(id));
  // Dragging over a folder opens it.
  const reveal = useRef<(id: string) => void>(() => {});
  reveal.current = (id) => {
    if (listing?.nodes.some((node) => node.id === id && noteType(node).container))
      setOpen(id, true);
  };
  const expandListeners = view?.expandListeners;
  useEffect(() => {
    if (!expandListeners) return;
    const listener = (id: string) => reveal.current(id);
    expandListeners.add(listener);
    return () => {
      expandListeners.delete(listener);
    };
  }, [expandListeners]);
  // A completed move opens every folder on the way to its destination, one
  // level at a time as each Branch loads.
  const revealPath = view?.reveal;
  useEffect(() => {
    if (!listing || !revealPath?.size) return;
    for (const node of listing.nodes)
      if (revealPath.has(node.id) && noteType(node).container) setOpen(node.id, true);
    // setOpen is recreated each render; listing and the path decide when to run.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [listing, revealPath]);
  if (!listing)
    return error ? (
      <p className="inline-error small" role="status">
        {error}
      </p>
    ) : (
      <Spinner label="加载目录…" />
    );
  return (
    <>
      {error && (
        <p className="inline-error small" role="status">
          {error}
        </p>
      )}
      {!listing.nodes.length && depth === 0 && (props.onNew
        ? <EmptyDirectory onNew={props.onNew} />
        : <p className="tree-empty">暂无笔记</p>)}
      <ul
        className="tree-branch"
        role={depth ? 'group' : 'tree'}
        aria-label={depth ? undefined : '笔记树'}
        aria-busy={loading}
      >
        {listing.nodes.map((node) => {
          // Any container accepts a drop; only one with children shows an arrow.
          const container = noteType(node).container,
            hasChildren = container && (node.child_count ?? 0) > 0,
            open = expanded.has(node.id);
          return (
            <li
              key={node.id}
              role="treeitem"
              data-tree-item={node.id}
              data-select-item={node.id}
              className={
                view?.drag?.source.id === node.id || view?.saving === node.id
                  ? 'is-drag-source'
                  : undefined
              }
              aria-selected={props.selected === node.id}
              aria-expanded={hasChildren ? open : undefined}
              // A note being created, shown ahead of the server (src/optimistic.ts).
              aria-busy={node.id.startsWith('pending-') || undefined}
            >
              <div
                className={[
                  'tree-row',
                  props.selected === node.id && 'selected',
                  chosen.scope === 'tree' && chosen.items.has(node.id) && 'is-multi-selected',
                  view?.drag?.target === node.id && 'is-drop-over',
                  view?.landed?.parent === node.id && 'is-drop-done',
                  view?.landed?.id === node.id && view.landed.parent === parent && 'is-landed',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{ '--tree-depth': Math.min(depth, 10) } as CSSProperties}
                data-tree-node={node.id}
                data-tree-title={node.title}
                data-tree-container={container ? 'true' : undefined}
                data-select-id={node.id}
                // Shift + click selects rows, not the text between them.
                onMouseDown={(event) => event.shiftKey && canMultiSelect() && event.preventDefault()}
                onPointerDown={(event) => view?.start.startMouse(event, node)}
                onTouchStart={(event) => view?.start.startTouch(event, node)}
              >
                <button
                  className={`tree-chevron ${hasChildren ? '' : 'invisible'}`}
                  tabIndex={hasChildren ? 0 : -1}
                  aria-hidden={hasChildren ? undefined : true}
                  aria-label={`${open ? '收起' : '展开'} ${node.title}`}
                  onClick={() => toggle(node.id)}
                >
                  <ChevronRight size={14} className={open ? 'is-open' : undefined} />
                </button>
                <button
                  className="tree-label"
                  aria-label={node.title}
                  onClick={(event) => selectClick(event, node, 'tree') || props.onOpen(node)}
                  title={node.title}
                >
                  <NodeIcon node={node} />
                  <span>{node.title}{props.browsing && <small>{nodeDescription(node)}</small>}</span>
                  <LockBadge keyId={node.key_id} />
                </button>
                <NodeMenu node={node} onAction={props.onAction} />
              </div>
              {hasChildren && open && depth < 100 && (
                <Branch {...props} onLoading={onLoading} parent={node.id} depth={depth + 1} />
              )}
            </li>
          );
        })}
        {listing.nextOffset !== null && (
          <li role="none">
            <button className="text-button load-more" onClick={more} disabled={loading}>
              {loading ? '正在加载…' : '加载更多'}
            </button>
          </li>
        )}
      </ul>
    </>
  );
}
export function Tree(props: TreeProps) {
  const preferences = useListPreferences();
  const offline = useOffline();
  const [requests, setRequests] = useState(new Set<symbol>());
  const [manualBusy, setManualBusy] = useState(false);
  const [error, setError] = useState('');
  const onLoading = useCallback((request: symbol, loading: boolean) => {
    setRequests((previous) => {
      if (previous.has(request) === loading) return previous;
      const next = new Set(previous);
      if (loading) next.add(request);
      else next.delete(request);
      return next;
    });
    if (loading) setError('');
  }, []);
  const busy = manualBusy || requests.size > 0;
  const root = useRef<HTMLDivElement>(null),
    ghost = useRef<HTMLDivElement>(null);
  const expandListeners = useRef(new Set<(id: string) => void>());
  const expand = useCallback((id: string) => {
    for (const listener of expandListeners.current) listener(id);
  }, []);
  const [saving, setSaving] = useState<string>();
  const [landed, setLanded] = useState<DragView['landed']>(null);
  const [reveal, setReveal] = useState<Set<string>>(() => new Set());
  const { onDrop, onDropMany } = props;
  const chosen = useSelection();
  // Dragging one of several selected rows carries them all.
  const group = (source: NoteNode) => {
    const current = selection();
    return current.scope === 'tree' && current.items.size > 1 && current.items.has(source.id) && onDropMany
      ? topSelected(current.items)
      : null;
  };
  const start = useTreeDrag(root, ghost, {
    onDrop: (source, target) => {
      const parent = target === ROOT_TARGET ? null : target;
      const title = parent
        ? root.current?.querySelector<HTMLElement>(`[data-tree-node="${CSS.escape(parent)}"]`)
            ?.dataset.treeTitle || ''
        : '';
      const nodes = group(source);
      if (nodes) {
        // Not into one of them, nor below one of them.
        const row = parent && root.current?.querySelector(`[data-tree-node="${CSS.escape(parent)}"]`);
        if (row && nodes.some((node) => row.closest(`[data-tree-item="${CSS.escape(node.id)}"]`))) return;
        setSaving(source.id);
        void onDropMany!(nodes, parent, title).finally(() => setSaving(undefined));
        return;
      }
      setSaving(source.id);
      void onDrop(source.id, parent, title).finally(() => setSaving(undefined));
    },
    onExpand: expand,
  });
  const { drag, startMouse, startTouch } = start;
  const moved = props.moved;
  useEffect(() => {
    if (!moved) return;
    const { id, parent } = moved;
    setReveal(new Set(parent ? [...(moved.path ?? []), parent] : []));
    setLanded({ id, parent });
    // Bring the moved row into view once its new location has loaded.
    const selector = parent
      ? `[data-tree-item="${CSS.escape(parent)}"] > ul > li > [data-tree-node="${CSS.escape(id)}"]`
      : `[role="tree"] > li > [data-tree-node="${CSS.escape(id)}"]`;
    // Nested folders load one after another, so allow a few seconds.
    const until = Date.now() + 6000;
    let frame = 0;
    const find = () => {
      const row = root.current?.querySelector(selector);
      if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      else if (Date.now() < until) frame = requestAnimationFrame(find);
    };
    frame = requestAnimationFrame(find);
    const timer = setTimeout(() => setLanded(null), 3000);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      setLanded(null);
      setReveal(new Set());
    };
  }, [moved]);
  const rootAvailable = !!drag && drag.source.parent_id !== null;
  const listeners = expandListeners.current;
  // Branches re-render only when what they show changes.
  const view = useMemo<DragView>(
    () => ({
      drag,
      saving,
      landed,
      reveal,
      start: { startMouse, startTouch },
      expandListeners: listeners,
    }),
    [drag, saving, landed, reveal, startMouse, startTouch, listeners],
  );
  const refresh = async () => {
    if (busy) return;
    setManualBusy(true);
    setError('');
    try {
      await props.onRefresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setManualBusy(false);
    }
  };
  return (
    <div ref={root} data-select-scope="tree" className={`tree${drag ? ' is-dragging' : ''}${props.browsing ? ` browsing-tree${preferences.compact ? ' is-compact' : ''}` : ''}`}>
      {props.browsing && <ListControls />}
      <div
        className={[
          'section-label',
          rootAvailable && 'is-root-available',
          drag?.target === ROOT_TARGET && 'is-root-over',
        ]
          .filter(Boolean)
          .join(' ')}
        data-tree-root
      >
        {rootAvailable ? (
          <span className="tree-root-drop">
            <CornerLeftUp size={14} />
            移到根目录
          </span>
        ) : (
          <span title="可拖到此处移至根目录">我的笔记</span>
        )}
        {props.showRefresh !== false && (
          <button
            type="button"
            className={`icon-button tree-refresh ${busy ? 'is-loading' : ''}`}
            aria-label="刷新目录"
            title={busy ? '正在刷新目录' : '刷新目录'}
            aria-busy={busy}
            disabled={busy}
            onClick={refresh}
          >
            <RefreshCw size={16} />
          </button>
        )}
      </div>
      {offline && (
        <p className="tree-offline" role="status">
          离线目录
        </p>
      )}
      {error && (
        <p className="inline-error small tree-refresh-error" role="status">
          {error}
        </p>
      )}
      <DragContext.Provider value={view}>
        <Branch {...props} listSort={props.browsing ? preferences.sort : undefined} onLoading={onLoading} parent={null} />
      </DragContext.Provider>
      {drag &&
        createPortal(
          <div
            ref={ghost}
            className={`tree-drag-ghost is-${drag.pointer}`}
            style={{ transform: ghostTransform(drag.x, drag.y, drag.pointer) }}
            aria-hidden="true"
          >
            <span className={`tree-drag-card${drag.target !== undefined ? ' can-drop' : ''}`}>
              <NodeIcon node={drag.source} />
              <span>{drag.source.title}</span>
              {chosen.scope === 'tree' && chosen.items.size > 1 && chosen.items.has(drag.source.id) && (
                <small>等 {topSelected(chosen.items).length} 项</small>
              )}
            </span>
          </div>,
          document.body,
        )}
    </div>
  );
}

// Uses the same lazy listing API as the sidebar; large libraries are never
// downloaded just to select a destination or insert a link.
export function NodePicker({
  value,
  onSelect,
  parentsOnly = false,
  exclude,
  label = '选择位置',
  initialPath = [],
}: {
  value: string | null;
  // `ancestors` are the selected folder's parents, from the top level down.
  onSelect: (id: string | null, title: string, ancestors: string[]) => void;
  parentsOnly?: boolean;
  exclude?: string | string[];
  label?: string;
  initialPath?: { id: string; title: string }[];
}) {
  const [path, setPath] = useState(initialPath);
  const [listing, setListing] = useState<Listing | null>(null),
    [error, setError] = useState('');
  const parent = path.at(-1)?.id || null;
  useEffect(() => {
    let live = true;
    setListing(null);
    setError('');
    api<Listing>(`/api/nodes?parent=${parent || ''}`)
      .then((data) => {
        if (live) setListing(data);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [parent]);
  return (
    <div className="node-picker" aria-label={label}>
      <div className="picker-breadcrumb">
        <button type="button" onClick={() => setPath([])}>
          全部笔记
        </button>
        {path.map((part, i) => (
          <button type="button" key={part.id} onClick={() => setPath((p) => p.slice(0, i + 1))}>
            / {part.title}
          </button>
        ))}
      </div>
      {parentsOnly && (
        <button
          type="button"
          className={`picker-row ${value === parent ? 'selected' : ''}`}
          onClick={() =>
            onSelect(
              parent,
              path.at(-1)?.title || '根目录',
              path.slice(0, -1).map((part) => part.id),
            )
          }
        >
          <Plus size={16} />
          <span>选择{parent ? '当前目录' : '根目录'}</span>
        </button>
      )}
      {error && <p className="inline-error">{error}</p>}
      {!listing && !error && <Spinner />}
      {listing?.nodes
        .filter((node) => ![exclude].flat().includes(node.id) && (!parentsOnly || noteType(node).container))
        .map((node) => (
          <div className={`picker-row ${value === node.id ? 'selected' : ''}`} key={node.id}>
            <button
              type="button"
              onClick={() =>
                onSelect(
                  node.id,
                  node.title,
                  path.map((part) => part.id),
                )
              }
            >
              <NodeIcon node={node} />
              <span>{node.title}</span>
            </button>
            {noteType(node).container && (
              <button
                type="button"
                className="icon-button"
                aria-label={`进入 ${node.title}`}
                onClick={() => setPath((p) => [...p, { id: node.id, title: node.title }])}
              >
                <ChevronRight size={17} />
              </button>
            )}
          </div>
        ))}
      {listing?.nextOffset !== null && listing && (
        <button
          type="button"
          className="text-button"
          onClick={async () => {
            try {
              const more = await api<Listing>(
                `/api/nodes?parent=${parent || ''}&offset=${listing.nextOffset}`,
              );
              setListing({ nodes: [...listing.nodes, ...more.nodes], nextOffset: more.nextOffset });
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          加载更多
        </button>
      )}
    </div>
  );
}
