import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, MoreHorizontal, Plus } from 'lucide-react';
import { api } from '../api';
import { PARENT_KINDS, type NoteNode } from '../../shared/types';
import { NodeIcon, Spinner } from './Primitives';

export type NodeAction = 'rename' | 'move' | 'delete' | 'new';
type Listing = { nodes: NoteNode[]; nextOffset: number | null };
export interface TreeProps {
  refresh: number;
  selected: string | null;
  editable: boolean;
  onOpen: (node: NoteNode) => void;
  onAction: (action: NodeAction, node: NoteNode) => void;
  onDrop: (id: string, parent: string | null) => void;
  onError: (error: unknown) => void;
}
export function NodeMenu({ node, onAction }: { node: NoteNode; onAction: TreeProps['onAction'] }) {
  return (
    <details className="node-menu">
      <summary role="button" className="icon-button" aria-label={`管理 ${node.title}`}>
        <MoreHorizontal size={18} />
      </summary>
      <div className="menu-popup">
        {PARENT_KINDS.includes(node.kind) && (
          <button onClick={() => onAction('new', node)}>新建子节点</button>
        )}
        <button onClick={() => onAction('rename', node)}>
          重命名{node.kind === 'link' ? ' / 修改链接' : ''}
        </button>
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
  ...props
}: TreeProps & { parent: string | null; depth?: number }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(sessionStorage.getItem('expanded-nodes') || '[]'));
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    let live = true;
    setError('');
    api<Listing>(`/api/nodes?parent=${parent || ''}`)
      .then((result) => {
        if (live) setListing(result);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [parent, props.refresh]);
  const toggle = (id: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      try {
        sessionStorage.setItem('expanded-nodes', JSON.stringify([...next]));
      } catch {
        /* Optional UI preference. */
      }
      return next;
    });
  const more = async () => {
    try {
      const result = await api<Listing>(
        `/api/nodes?parent=${parent || ''}&offset=${listing?.nextOffset}`,
      );
      setListing((previous) => ({
        nodes: [...(previous?.nodes || []), ...result.nodes],
        nextOffset: result.nextOffset,
      }));
    } catch (e) {
      props.onError(e);
    }
  };
  if (error) return <p className="inline-error small">{error}</p>;
  if (!listing) return <Spinner label="加载目录…" />;
  if (!listing.nodes.length)
    return depth === 0 ? (
      <p className="tree-empty">
        这里还没有笔记。
        <br />
        从第一篇开始吧。
      </p>
    ) : null;
  return (
    <ul
      className="tree-branch"
      role={depth ? 'group' : 'tree'}
      aria-label={depth ? undefined : '笔记树'}
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
              draggable={props.editable}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/x-note-id', node.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                if (
                  props.editable &&
                  hasChildren &&
                  e.dataTransfer.types.includes('text/x-note-id')
                ) {
                  e.preventDefault();
                  e.currentTarget.classList.add('drop-target');
                }
              }}
              onDragLeave={(e) => e.currentTarget.classList.remove('drop-target')}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                e.currentTarget.classList.remove('drop-target');
                if (props.editable && hasChildren)
                  props.onDrop(e.dataTransfer.getData('text/x-note-id'), node.id);
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
              <button className="tree-label" onClick={() => props.onOpen(node)} title={node.title}>
                <NodeIcon kind={node.kind} />
                <span>{node.title}</span>
              </button>
              {props.editable && <NodeMenu node={node} onAction={props.onAction} />}
            </div>
            {hasChildren && open && depth < 100 && (
              <Branch {...props} parent={node.id} depth={depth + 1} />
            )}
          </li>
        );
      })}
      {listing.nextOffset !== null && (
        <li role="none">
          <button className="text-button load-more" onClick={more}>
            加载更多
          </button>
        </li>
      )}
    </ul>
  );
}
export function Tree(props: TreeProps) {
  return (
    <div className="tree">
      <div
        className="section-label"
        onDragOver={(e) => {
          if (props.editable) e.preventDefault();
        }}
        onDrop={(e) => {
          if (props.editable) props.onDrop(e.dataTransfer.getData('text/x-note-id'), null);
        }}
      >
        <span>我的笔记</span>
        <span className="root-drop-hint">可拖到此处移至根目录</span>
      </div>
      <Branch {...props} parent={null} />
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
}: {
  value: string | null;
  onSelect: (id: string | null, title: string) => void;
  parentsOnly?: boolean;
  exclude?: string;
  label?: string;
}) {
  const [path, setPath] = useState<{ id: string; title: string }[]>([]);
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
        <button onClick={() => setPath([])}>全部笔记</button>
        {path.map((part, i) => (
          <button key={part.id} onClick={() => setPath((p) => p.slice(0, i + 1))}>
            / {part.title}
          </button>
        ))}
      </div>
      {parentsOnly && (
        <button
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
            <button onClick={() => onSelect(node.id, node.title)}>
              <NodeIcon kind={node.kind} />
              <span>{node.title}</span>
            </button>
            {PARENT_KINDS.includes(node.kind) && (
              <button
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
