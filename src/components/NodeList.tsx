import { useState } from 'react';
import { ArrowUpRight, ChevronRight, History, Star } from 'lucide-react';
import { formatDate } from '../api';
import { KIND_LABELS, type NoteNode } from '../../shared/types';
import { Empty, NodeIcon, Spinner } from './Primitives';
import { NodeMenu, type NodeAction } from './Tree';
import { useNodeListing } from '../use-node-listing';

type NodeListProps = {
  refresh: number;
  onOpen: (node: NoteNode) => void;
  onAction: (action: NodeAction, node: NoteNode) => void;
};
export function NodeList({
  view,
  parent,
  ...props
}: NodeListProps & { view?: 'favorites' | 'recent'; parent?: string | null }) {
  const query = view ? `view=${view}` : `parent=${parent || ''}`;
  const { listing, error, loading, more } = useNodeListing(query, props.refresh);
  if (!listing)
    return error ? (
      <p className="inline-error" role="status">
        {error}
      </p>
    ) : (
      <Spinner />
    );
  const items = listing.nodes;
  if (error && !items.length)
    return (
      <p className="inline-error" role="status">
        {error}
      </p>
    );
  if (!items.length)
    return view ? (
      <Empty
        icon={view === 'favorites' ? <Star /> : <History />}
        title={view === 'favorites' ? '暂无收藏' : '暂无阅读记录'}
      >
        {view === 'favorites' ? '点击笔记旁的星标添加收藏。' : undefined}
      </Empty>
    ) : (
      <p className="children-empty">此目录还没有内容</p>
    );
  return (
    <div className="node-list" aria-busy={loading}>
      <NodeRows {...props} items={items} error={error} />
      {listing.nextOffset !== null && (
        <button className="text-button load-more" onClick={more} disabled={loading}>
          {loading ? '正在加载…' : '加载更多'}
        </button>
      )}
    </div>
  );
}
// A shallow look inside: rows that have children can be expanded in place.
// Expansion is not remembered; the sidebar tree is the place for deep browsing.
function NodeRows({
  items,
  error,
  depth = 0,
  ...props
}: NodeListProps & { items: NoteNode[]; error: string; depth?: number }) {
  const [open, setOpen] = useState(() => new Set<string>());
  const nestable = items.some((node) => (node.child_count ?? 0) > 0);
  return (
    <>
      {error && (
        <p className="inline-error" role="status">
          {error}
        </p>
      )}
      {items.map((node) => {
        const count = node.child_count ?? 0,
          expanded = count > 0 && open.has(node.id);
        return (
          <div className="node-list-item" key={node.id}>
            <div className={`node-list-row${nestable ? ' is-nestable' : ''}`}>
              {count > 0 ? (
                <button
                  className="node-list-toggle"
                  aria-expanded={expanded}
                  aria-label={`${expanded ? '收起' : '展开'} ${node.title}`}
                  onClick={() =>
                    setOpen((value) => {
                      const next = new Set(value);
                      if (next.has(node.id)) next.delete(node.id);
                      else next.add(node.id);
                      return next;
                    })
                  }
                >
                  <ChevronRight size={16} />
                </button>
              ) : (
                nestable && <span className="node-list-toggle" aria-hidden="true" />
              )}
              <button className="node-list-main" onClick={() => props.onOpen(node)}>
                <NodeIcon node={node} kind={node.arxiv_id ? 'arxiv' : node.kind} size={20} />
                <span>
                  <strong>{node.title}</strong>
                  <small>
                    {node.arxiv_id
                      ? `arXiv 论文 · ${node.arxiv_id}`
                      : node.kind === 'link'
                        ? node.url
                        : KIND_LABELS[node.kind]}
                  </small>
                </span>
                {node.kind === 'link' && !node.arxiv_id ? (
                  <ArrowUpRight size={16} />
                ) : (
                  <time>{formatDate(node.updated_at)}</time>
                )}
              </button>
              <NodeMenu node={node} onAction={props.onAction} />
            </div>
            {expanded && <NodeChildren {...props} parent={node.id} depth={depth + 1} />}
          </div>
        );
      })}
    </>
  );
}
function NodeChildren({
  parent,
  depth,
  ...props
}: NodeListProps & { parent: string; depth: number }) {
  const { listing, error, loading, more } = useNodeListing(`parent=${parent}`, props.refresh);
  return (
    <div className="node-list-children" role="group" aria-busy={loading}>
      {!listing ? (
        error ? (
          <p className="inline-error small" role="status">
            {error}
          </p>
        ) : (
          <Spinner label="加载下级…" />
        )
      ) : !listing.nodes.length ? (
        <p className="children-empty">没有下级笔记</p>
      ) : (
        <NodeRows {...props} items={listing.nodes} error={error} depth={depth} />
      )}
      {listing?.nextOffset != null && (
        <button className="text-button load-more" onClick={more} disabled={loading}>
          {loading ? '正在加载…' : '加载更多'}
        </button>
      )}
    </div>
  );
}
