import { useEffect, useId, useRef, useState } from 'react';
import { MessageSquareQuote, Search } from 'lucide-react';
import { api } from '../api';
import { searchCachedTitles } from '../offline-cache';
import type { NoteNode, SearchResult } from '../../shared/types';
import { Modal, NodeIcon } from './Primitives';
import { requestAnnotation } from '../annotations';
import { requestFind } from '../find-request';
import { searchEncryptedBodies } from '../local-search';
import { compareSearch, searchTypes, type SearchType, type SearchSort } from '../../shared/search';
import { SEARCH_LIMIT } from '../../shared/types';

const wordsOf = (query: string) => query.trim().split(/\s+/).filter(Boolean).slice(0, 8);
// Server results first, then encrypted notes found on this device.
const merge = (server: SearchResult[], local: SearchResult[]) => [
  ...server,
  ...local.filter((node) => !server.some((other) => other.id === node.id)),
];
// The excerpt with the searched words marked.
function marked(text: string, words: string[]) {
  const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (!pattern) return text;
  return text.split(new RegExp(`(${pattern})`, 'gi')).map((part, index) =>
    index % 2 ? <mark key={index}>{part}</mark> : part,
  );
}
// Opening a result goes to what matched: the annotation, or the word in the body.
function goTo(node: SearchResult, query: string) {
  if (node.annotation) requestAnnotation(node.id, node.annotation.id);
  else if (node.excerpt) requestFind(node.id, wordsOf(query)[0]!);
}

// Jump to a note by title or body, or to one of its highlights and notes:
// Ctrl+K or / on computers, the search button on phones. With nothing typed it
// lists recent visits. Encrypted bodies are searched on this device only.
export function SearchDialog({
  onOpen,
  onClose,
  directory,
}: {
  onOpen: (node: NoteNode) => void;
  onClose: () => void;
  directory?: { id: string; title: string };
}) {
  const [currentDirectory, setCurrentDirectory] = useState(false),
    [type, setType] = useState<SearchType>('all'),
    [sort, setSort] = useState<SearchSort>('relevance');
  const parent = currentDirectory ? directory?.id : undefined;
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
    const options = { type, sort, parent };
    const ordered = (items: SearchResult[]) => items.sort((a, b) => compareSearch(a, b, wordsOf(term), sort)).slice(0, SEARCH_LIMIT);
    setState('loading');
    setResults([]);
    setActive(0);
    let answered = false;
    // Titles this device has seen show at once; the server's results replace them.
    if (term)
      void searchCachedTitles(wordsOf(term), SEARCH_LIMIT, options).then((found) => {
        if (!live || answered || !found.length) return;
        setResults(found.map((node): SearchResult => ({ ...node, path: [] })));
        setState('local');
      });
    const timer = setTimeout(
      () => {
        const local = term ? searchEncryptedBodies(wordsOf(term), options).catch(() => []) : Promise.resolve([]);
        const params = new URLSearchParams({ q: term, type, sort });
        if (parent) params.set('parent', parent);
        const request = term
          ? api<{ results: SearchResult[] }>(`/api/search?${params}`).then(
              (data) => data.results,
            )
          : parent || type !== 'all' ? Promise.resolve([] as SearchResult[])
          : api<{ nodes: NoteNode[] }>('/api/nodes?view=recent').then((data) =>
              data.nodes.map((node): SearchResult => ({ ...node, path: [] })),
            );
        request
          .then(async (server) => {
            const found = term ? ordered(merge(server, await local)) : server;
            answered = true;
            if (!live) return;
            if (pendingEnter.current && found[0]) {
              pendingEnter.current = false;
              handlers.current.onClose();
              goTo(found[0], term);
              handlers.current.onOpen(found[0]);
              return;
            }
            pendingEnter.current = false;
            setResults(found);
            setActive(0);
            setState('ready');
          })
          .catch(async (e) => {
            answered = true;
            const found = await local;
            if (!live) return;
            setError((e as Error).message);
            pendingEnter.current = false;
            // Titles and encrypted notes found on this device stay, marked as such.
            if (found.length) setResults((shown) => ordered(merge(shown, found)));
            setState('error');
          });
      },
      term ? 180 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, type, sort, parent]);
  const changeFilters = () => { pendingEnter.current = false; };
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const open = (node: SearchResult) => {
    // Results always belong to the current query: they are cleared when it changes.
    if (state === 'loading') return;
    onClose();
    goTo(node, query);
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
          aria-label="搜索笔记标题、正文或批注"
          aria-expanded={results.length > 0}
          aria-controls={list}
          aria-activedescendant={results.length ? optionId(active) : undefined}
          placeholder="搜索标题、正文和批注"
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
      <div className="search-filters">
        <label>范围<select aria-label="搜索范围" value={currentDirectory ? 'current' : 'all'} onChange={(event) => { changeFilters(); setCurrentDirectory(event.target.value === 'current'); }}>
          <option value="all">全部笔记</option>
          <option value="current" disabled={!directory}>{directory ? `当前目录：${directory.title}` : '当前目录'}</option>
        </select></label>
        <label>类型<select aria-label="搜索类型" value={type} onChange={(event) => { changeFilters(); setType(event.target.value as SearchType); }}>
          {Object.entries(searchTypes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>排序<select aria-label="搜索排序" value={sort} onChange={(event) => { changeFilters(); setSort(event.target.value as SearchSort); }}>
          <option value="relevance">相关度</option><option value="updated">最近更新</option>
        </select></label>
      </div>
      <p className="search-caption" aria-live="polite">
        {state === 'error'
          ? results.length
            ? `${error.replace(/[。.]$/, '')}，先显示已找到的`
            : error
          : state === 'loading'
            ? '正在查找…'
            : state === 'local'
              ? `找到 ${results.length} 项，继续查找中…`
            : query.trim()
              ? results.length
                ? `找到 ${results.length} 项${results.length >= SEARCH_LIMIT ? `（最多显示${sort === 'relevance' ? '最相关' : '最近修改'}的 ${SEARCH_LIMIT} 项）` : ''}`
                : '没有标题、正文或批注匹配的笔记'
              : results.length
                ? '最近访问'
                : '输入标题、正文或批注中的文字开始搜索'}
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
              {node.excerpt && !node.annotation && (
                <span className="search-excerpt">
                  {node.local && <span className="search-local">本机</span>}
                  {marked(node.excerpt, wordsOf(query))}
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
