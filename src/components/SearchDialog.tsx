import { useEffect, useId, useRef, useState } from 'react';
import { MessageSquareQuote, Search } from 'lucide-react';
import { api } from '../api';
import { searchCachedTitles } from '../offline-cache';
import type { NoteNode, SearchResult } from '../../shared/types';
import { Modal, NodeIcon } from './Primitives';
import { requestAnnotation } from '../annotations';

// Jump to a note by title, or to one of its highlights and notes: Ctrl+K or /
// on computers, the search button on phones. With nothing typed it lists
// recent visits.
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
    // 'local': titles from this device, shown until the server answers.
    [state, setState] = useState<'loading' | 'local' | 'ready' | 'error'>('loading'),
    [error, setError] = useState('');
  const list = useId();
  const listRef = useRef<HTMLUListElement>(null),
    field = useRef<HTMLInputElement>(null);
  // Enter pressed while a search is pending opens its first result on arrival.
  const pendingEnter = useRef(false);
  const handlers = useRef({ onOpen, onClose });
  handlers.current = { onOpen, onClose };
  // Opening the dialog focuses its first button; move to the field after that.
  useEffect(() => {
    const frame = requestAnimationFrame(() => field.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    let live = true;
    const term = query.trim();
    setState('loading');
    setResults([]);
    setActive(0);
    let answered = false;
    // Titles this device has seen show at once; the server's results replace them.
    if (term)
      void searchCachedTitles(term.split(/\s+/).filter(Boolean).slice(0, 8)).then((found) => {
        if (!live || answered || !found.length) return;
        setResults(found.map((node): SearchResult => ({ ...node, path: [] })));
        setState('local');
      });
    const timer = setTimeout(
      () => {
        const request = term
          ? api<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(term)}`).then(
              (data) => data.results,
            )
          : api<{ nodes: NoteNode[] }>('/api/nodes?view=recent').then((data) =>
              data.nodes.map((node): SearchResult => ({ ...node, path: [] })),
            );
        request
          .then((found) => {
            answered = true;
            if (!live) return;
            if (pendingEnter.current && found[0]) {
              pendingEnter.current = false;
              handlers.current.onClose();
              if (found[0].annotation) requestAnnotation(found[0].id, found[0].annotation.id);
              handlers.current.onOpen(found[0]);
              return;
            }
            pendingEnter.current = false;
            setResults(found);
            setActive(0);
            setState('ready');
          })
          .catch((e) => {
            answered = true;
            if (!live) return;
            setError((e as Error).message);
            pendingEnter.current = false;
            // Titles found on this device stay, marked as such.
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
  const open = (node: SearchResult) => {
    // Results always belong to the current query: they are cleared when it changes.
    if (state === 'loading') return;
    onClose();
    if (node.annotation) requestAnnotation(node.id, node.annotation.id);
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
          aria-label="搜索笔记标题或批注"
          aria-expanded={results.length > 0}
          aria-controls={list}
          aria-activedescendant={results.length ? optionId(active) : undefined}
          placeholder="输入标题或批注中的文字，多个词用空格分开"
          value={query}
          maxLength={200}
          onChange={(event) => {
            pendingEnter.current = false;
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (!results.length) return;
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setActive((index) => (index + step + results.length) % results.length);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              // While a search is pending the list is from the previous query.
              if (state === 'loading' || state === 'local') pendingEnter.current = true;
              else if (results[active]) open(results[active]);
            }
          }}
        />
      </label>
      <p className="search-caption" aria-live="polite">
        {state === 'error'
          ? results.length
            ? `${error} 以下是本机缓存中标题匹配的笔记。`
            : error
          : state === 'loading'
            ? '正在查找…'
            : state === 'local'
              ? `本机找到 ${results.length} 项，正在查找全部…`
            : query.trim()
              ? results.length
                ? `找到 ${results.length} 项${results.length >= 30 ? '（只显示最近修改的 30 项）' : ''}`
                : '没有标题或批注匹配的笔记'
              : results.length
                ? '最近访问'
                : '输入标题或批注中的文字开始搜索'}
      </p>
      <ul id={list} ref={listRef} className="search-results" role="listbox" aria-label="搜索结果">
        {results.map((node, index) => (
          <li
            key={`${node.id}:${node.annotation?.id ?? ''}`}
            id={optionId(index)}
            data-index={index}
            role="option"
            aria-selected={index === active}
            className={index === active ? 'active' : ''}
            onMouseMove={() => setActive(index)}
            onClick={() => open(node)}
          >
            <NodeIcon node={node} />
            <span className="search-result-text">
              <strong>{node.title}</strong>
              {node.annotation && (
                <span className="search-annotation">
                  <MessageSquareQuote size={13} aria-hidden="true" />
                  {node.annotation.note ? (
                    <>
                      <q>{node.annotation.quote}</q> {node.annotation.note}
                    </>
                  ) : (
                    <q>{node.annotation.quote}</q>
                  )}
                </span>
              )}
              {node.path.length > 0 && <small>{node.path.join(' / ')}</small>}
            </span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
