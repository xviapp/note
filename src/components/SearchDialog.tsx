import { useEffect, useId, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { api } from '../api';
import type { NoteNode, SearchResult } from '../../shared/types';
import { Modal, NodeIcon } from './Primitives';

// Jump to a note by title: Ctrl+K or / on computers, the search button on phones.
// With nothing typed it lists recent visits.
export function SearchDialog({
  onOpen,
  onClose,
}: {
  onOpen: (node: NoteNode) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(''),
    [results, setResults] = useState<SearchResult[]>([]),
    [active, setActive] = useState(0),
    [state, setState] = useState<'loading' | 'ready' | 'error'>('loading'),
    [error, setError] = useState('');
  const list = useId();
  const listRef = useRef<HTMLUListElement>(null),
    field = useRef<HTMLInputElement>(null);
  // Opening the dialog focuses its first button; move to the field after that.
  useEffect(() => {
    const frame = requestAnimationFrame(() => field.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    let live = true;
    const term = query.trim();
    setState('loading');
    const timer = setTimeout(
      () => {
        const request = term
          ? api<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(term)}`).then(
              (data) => data.results,
            )
          : api<{ nodes: NoteNode[] }>('/api/nodes?view=recent').then((data) =>
              data.nodes.map((node) => ({ ...node, path: [] })),
            );
        request
          .then((found) => {
            if (!live) return;
            setResults(found);
            setActive(0);
            setState('ready');
          })
          .catch((e) => {
            if (!live) return;
            setError((e as Error).message);
            setState('error');
          });
      },
      term ? 180 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const open = (node: NoteNode) => {
    onClose();
    onOpen(node);
  };
  const optionId = (index: number) => `${list}-${index}`;
  return (
    <Modal title="搜索笔记" className="search-modal" onClose={onClose}>
      <label className="search-field">
        <Search size={17} aria-hidden="true" />
        <input
          ref={field}
          type="text"
          enterKeyHint="go"
          autoComplete="off"
          role="combobox"
          aria-label="搜索笔记标题"
          aria-expanded={results.length > 0}
          aria-controls={list}
          aria-activedescendant={results.length ? optionId(active) : undefined}
          placeholder="输入标题中的文字，多个词用空格分开"
          value={query}
          maxLength={200}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (!results.length) return;
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setActive((index) => (index + step + results.length) % results.length);
            } else if (event.key === 'Enter' && results[active]) {
              event.preventDefault();
              open(results[active]);
            }
          }}
        />
      </label>
      <p className="search-caption" aria-live="polite">
        {state === 'error'
          ? error
          : state === 'loading'
            ? '正在查找…'
            : query.trim()
              ? results.length
                ? `找到 ${results.length} 篇${results.length >= 30 ? '（只显示最近修改的 30 篇）' : ''}`
                : '没有标题匹配的笔记'
              : results.length
                ? '最近访问'
                : '输入标题中的文字开始搜索'}
      </p>
      <ul id={list} ref={listRef} className="search-results" role="listbox" aria-label="搜索结果">
        {results.map((node, index) => (
          <li
            key={node.id}
            id={optionId(index)}
            data-index={index}
            role="option"
            aria-selected={index === active}
            className={index === active ? 'active' : ''}
            onMouseMove={() => setActive(index)}
            onClick={() => open(node)}
          >
            <NodeIcon kind={node.arxiv_id ? 'arxiv' : node.kind} node={node} />
            <span className="search-result-text">
              <strong>{node.title}</strong>
              {node.path.length > 0 && <small>{node.path.join(' / ')}</small>}
            </span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
