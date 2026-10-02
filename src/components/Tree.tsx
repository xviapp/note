import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, MoreHorizontal, Plus, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { PARENT_KINDS, type NoteNode } from '../../shared/types';
import { NodeIcon, Spinner } from './Primitives';
import { OfflineSaveButton } from './OfflineCache';
import { useNodeListing, type NodeListing as Listing } from '../use-node-listing';
import { useOffline } from '../connectivity';

export type NodeAction = 'rename' | 'move' | 'delete' | 'new' | 'icon';
export interface TreeProps {
  expansionState?: Set<string>;
  showRefresh?: boolean;
  refresh: number;
  onRefresh: () => Promise<void>;
  selected: string | null;
  onOpen: (node: NoteNode) => void;
  onAction: (action: NodeAction, node: NoteNode) => void;
  onDrop: (id: string, parent: string | null) => void;
}
export function NodeMenu({ node, onAction }: { node: NoteNode; onAction: TreeProps['onAction'] }) {
  return (
    <details className="node-menu" name="node-actions">
      <summary role="button" className="icon-button" aria-label={`管理 ${node.title}`}>
        <MoreHorizontal size={18} />
      </summary>
      <div className="menu-popup">
        <OfflineSaveButton node={node} />
        {PARENT_KINDS.includes(node.kind) && (
          <button onClick={() => onAction('new', node)}>新建笔记</button>
        )}
        <button onClick={() => onAction('rename', node)}>
          重命名{node.kind === 'link' && !node.arxiv_id ? ' / 修改链接' : ''}
        </button>
        {node.kind === 'folder' && <button onClick={() => onAction('icon', node)}>更换图标</button>}
        <button onClick={() => onAction('move', node)}>移动到…</button>
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
  const { listing, error, loading, more } = useNodeListing(
    `parent=${parent || ''}`,
    props.refresh,
  );
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
  const toggle = (id: string) => {
    const next = new Set(props.expansionState || expanded);
    next.has(id) ? next.delete(id) : next.add(id);
    if (props.expansionState) {
      props.expansionState.clear();
      for (const value of next) props.expansionState.add(value);
    }
    try {
      sessionStorage.setItem('expanded-nodes', JSON.stringify([...next]));
    } catch {
      /* Optional UI preference. */
    }
    setExpanded(next);
  };
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
      {!listing.nodes.length && depth === 0 && <p className="tree-empty">暂无笔记</p>}
      <ul
        className="tree-branch"
        role={depth ? 'group' : 'tree'}
        aria-label={depth ? undefined : '笔记树'}
        aria-busy={loading}
      >
        {listing.nodes.map((node) => {
          const hasChildren = PARENT_KINDS.includes(node.kind),
            open = expanded.has(node.id);
          return (
            <li
              key={node.id}
              role="treeitem"
              aria-selected={props.selected === node.id}
              aria-expanded={hasChildren ? open : undefined}
            >
              <div
                className={`tree-row ${props.selected === node.id ? 'selected' : ''}`}
                style={{ paddingLeft: 8 + Math.min(depth, 10) * 15 }}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/x-note-id', node.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  if (hasChildren && e.dataTransfer.types.includes('text/x-note-id')) {
                    e.preventDefault();
                    e.currentTarget.classList.add('drop-target');
                  }
                }}
                onDragLeave={(e) => e.currentTarget.classList.remove('drop-target')}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  e.currentTarget.classList.remove('drop-target');
                  if (hasChildren) props.onDrop(e.dataTransfer.getData('text/x-note-id'), node.id);
                }}
              >
                <button
                  className={`tree-chevron ${hasChildren ? '' : 'invisible'}`}
                  tabIndex={hasChildren ? 0 : -1}
                  aria-label={`${open ? '收起' : '展开'} ${node.title}`}
                  onClick={() => toggle(node.id)}
                >
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                <button
                  className="tree-label"
                  onClick={() => props.onOpen(node)}
                  title={node.title}
                >
                  <NodeIcon node={node} kind={node.arxiv_id ? 'arxiv' : node.kind} />
                  <span>{node.title}</span>
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
    <div className="tree">
      <div
        className="section-label"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('text/x-note-id')) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          props.onDrop(e.dataTransfer.getData('text/x-note-id'), null);
        }}
      >
        <span title="可拖到此处移至根目录">我的笔记</span>
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
      <Branch {...props} onLoading={onLoading} parent={null} />
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
  onSelect: (id: string | null, title: string) => void;
  parentsOnly?: boolean;
  exclude?: string;
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
          onClick={() => onSelect(parent, path.at(-1)?.title || '根目录')}
        >
          <Plus size={16} />
          <span>选择{parent ? '当前目录' : '根目录'}</span>
        </button>
      )}
      {error && <p className="inline-error">{error}</p>}
      {!listing && !error && <Spinner />}
      {listing?.nodes
        .filter((node) => node.id !== exclude && (!parentsOnly || PARENT_KINDS.includes(node.kind)))
        .map((node) => (
          <div className={`picker-row ${value === node.id ? 'selected' : ''}`} key={node.id}>
            <button type="button" onClick={() => onSelect(node.id, node.title)}>
              <NodeIcon node={node} kind={node.arxiv_id ? 'arxiv' : node.kind} />
              <span>{node.title}</span>
            </button>
            {PARENT_KINDS.includes(node.kind) && (
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
