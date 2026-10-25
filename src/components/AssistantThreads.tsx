import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { AssistantThread } from '../../shared/assistant';
import { formatDate } from '../api';
import { refreshThreads, requestAssistant, useAssistantThreads } from '../assistant-threads';
import { Modal, NodeIcon } from './Primitives';

// 青藜对话: every note's conversation in one place, the most recent first.
// Opening one goes to its note (a discussion's page) with 青藜 open.
export function AssistantThreads({
  onOpen,
  onClose,
}: {
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const threads = useAssistantThreads();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading'),
    [error, setError] = useState('');
  const [query, setQuery] = useState(''),
    [active, setActive] = useState(0);
  const list = useId();
  const listRef = useRef<HTMLUListElement>(null),
    field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    refreshThreads()
      .then(() => live && setState('ready'))
      .catch((e: Error) => {
        if (!live) return;
        setError(e.message);
        setState('error');
      });
    // Opening the dialog focuses its first button; move to the field after that.
    const frame = requestAnimationFrame(() => field.current?.focus());
    return () => {
      live = false;
      cancelAnimationFrame(frame);
    };
  }, []);
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return threads.filter((thread) => {
      const text = [thread.title, ...thread.path].join(' ').toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }, [threads, query]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const open = (thread: AssistantThread) => {
    onClose();
    onOpen(requestAssistant(thread));
  };
  const optionId = (index: number) => `${list}-${index}`;
  return (
    <Modal title="青藜对话" className="search-modal assistant-threads-modal" onClose={onClose}>
      <label className="search-field">
        <Search size={17} aria-hidden="true" />
        <input
          ref={field}
          type="text"
          enterKeyHint="go"
          autoComplete="off"
          role="combobox"
          aria-label="按笔记标题或位置筛选"
          aria-expanded={shown.length > 0}
          aria-controls={list}
          aria-activedescendant={shown.length ? optionId(active) : undefined}
          placeholder="按笔记标题或位置筛选"
          value={query}
          maxLength={200}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (!shown.length) return;
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setActive((index) => (index + step + shown.length) % shown.length);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              if (shown[active]) open(shown[active]);
            }
          }}
        />
      </label>
      <p className="search-caption" aria-live="polite">
        {state === 'error'
          ? threads.length
            ? `${error.replace(/[。.]$/, '')}，先显示本机上次的列表`
            : error
          : state === 'loading' && !threads.length
            ? '正在读取…'
            : !threads.length
              ? '还没有和青藜聊过的笔记。在笔记里打开青藜提问后，会话会出现在这里。'
              : query.trim()
                ? shown.length
                  ? `${shown.length} 段对话`
                  : '没有标题或位置匹配的会话'
                : `${threads.length} 段对话，最近聊过的在前`}
      </p>
      <ul id={list} ref={listRef} className="search-results" role="listbox" aria-label="青藜会话">
        {shown.map((thread, index) => (
          <li
            key={thread.id}
            id={optionId(index)}
            data-index={index}
            role="option"
            aria-selected={index === active}
            className={index === active ? 'active' : ''}
            onMouseMove={() => setActive(index)}
            onClick={() => open(thread)}
          >
            <NodeIcon node={thread} />
            <span className="search-result-text">
              <strong>{thread.title}</strong>
              <span className="assistant-thread-meta">
                {thread.questions} 次提问 · {formatDate(thread.chat_at)}
              </span>
              {thread.path.length > 0 && <small>{thread.path.join(' / ')}</small>}
            </span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
