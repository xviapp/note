import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronLeft, ChevronRight, FileText, MessagesSquare, RefreshCw, Send } from 'lucide-react';
import { api } from '../api';
import type { BookPageInfo, BookPages, NoteNode } from '../../shared/types';
import { NodeIcon, Spinner } from './Primitives';

// Turning pages within the book.
export function BookPageNav({
  info,
  onNavigate,
}: {
  info: BookPageInfo;
  onNavigate: (id: string) => void;
}) {
  return (
    <div className="book-page-nav">
      <button
        className="icon-button"
        aria-label="上一页"
        disabled={!info.prev}
        onClick={() => info.prev && onNavigate(info.prev)}
      >
        <ChevronLeft size={18} />
      </button>
      <button
        className="icon-button"
        aria-label="下一页"
        disabled={!info.next}
        onClick={() => info.next && onNavigate(info.next)}
      >
        <ChevronRight size={18} />
      </button>
    </div>
  );
}

// Below a page's text: 青藜's summary and questions, the page's discussions and
// its reading note.
export function PageInsights({
  id,
  info,
  offline,
  onAsk,
  onOpenDiscussion,
  onNavigate,
  onUpdated,
  onError,
}: {
  id: string;
  info: BookPageInfo;
  offline: boolean;
  onAsk: (question: string) => void;
  onOpenDiscussion: (id: string) => void;
  onNavigate: (id: string) => void;
  onUpdated: () => void;
  onError: (error: unknown) => void;
}) {
  const [generating, setGenerating] = useState(false);
  const generate = async () => {
    setGenerating(true);
    try {
      await api(`/api/nodes/${id}/insights`, 'POST', {});
      onUpdated();
    } catch (error) {
      onError(error);
    } finally {
      setGenerating(false);
    }
  };
  return (
    <section className="page-insights" aria-label="本页摘要与讨论">
      <div className="page-summary">
        <div className="page-insights-heading">
          <span>本页摘要</span>
          {(info.summary || !offline) && (
            <button
              className="text-button"
              disabled={offline || generating}
              onClick={() => void generate()}
            >
              <RefreshCw size={13} className={generating ? 'spin' : undefined} />
              {generating
                ? '正在生成…'
                : info.summary
                  ? info.stale
                    ? '页面已修改，重新生成'
                    : '重新生成'
                  : '生成摘要和问题'}
            </button>
          )}
        </div>
        {info.summary ? (
          <>
            <p>{info.summary}</p>
            {info.questions.length > 0 && (
              <>
                <div className="page-insights-label">值得追问</div>
                {info.questions.map((question) => (
                  <button
                    key={question}
                    className="page-question"
                    disabled={offline}
                    onClick={() => onAsk(question)}
                  >
                    {question}
                  </button>
                ))}
              </>
            )}
          </>
        ) : (
          <p className="muted-text">青藜还没有为这一页写摘要。</p>
        )}
      </div>
      <div className="page-discussions">
        <div className="page-insights-heading">
          <span>讨论（{info.discussions.length}）</span>
        </div>
        {info.discussions.length ? (
          info.discussions.map((discussion) => (
            <button
              key={discussion.id}
              className="page-discussion"
              onClick={() => onOpenDiscussion(discussion.id)}
            >
              <MessagesSquare size={16} />
              <span>
                <strong>{discussion.title}</strong>
                <small>
                  {discussion.replies} 条回复{discussion.noted ? ' · 已整理到笔记' : ''}
                </small>
              </span>
            </button>
          ))
        ) : (
          <p className="muted-text">还没有讨论。点上面的问题、划词「问青藜」或在下方提问。</p>
        )}
      </div>
      {info.note_id && (
        <button className="page-note-link" onClick={() => onNavigate(info.note_id!)}>
          <FileText size={18} />
          <span>
            <strong>本页读书笔记</strong>
            <small>讨论整理后的结论与依据</small>
          </span>
        </button>
      )}
    </section>
  );
}

// "Ask about this page" at the foot of a book page.
export function PageAskBar({
  offline,
  onAsk,
}: {
  offline: boolean;
  onAsk: (question: string) => void;
}) {
  const [text, setText] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    onAsk(text.trim());
    setText('');
  };
  return (
    <form className="page-ask" onSubmit={submit}>
      <input
        value={text}
        maxLength={8000}
        placeholder="就这一页提问…"
        aria-label="就这一页提问"
        disabled={offline}
        onChange={(event) => setText(event.target.value)}
      />
      <button className="button primary compact" disabled={offline || !text.trim()}>
        <Send size={15} />
        <span>提问</span>
      </button>
    </form>
  );
}

// Switching between a page's discussions in 青藜's title bar.
export function DiscussionMenu({
  info,
  current,
  onPick,
}: {
  info: BookPageInfo;
  current: string | null;
  onPick: (id: string | null) => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const pick = (id: string | null) => {
    if (menu.current) menu.current.open = false;
    onPick(id);
  };
  return (
    <details className="node-menu discussion-menu" ref={menu}>
      <summary role="button" className="text-button" aria-label="切换讨论">
        讨论 ▾
      </summary>
      <div className="menu-popup">
        {info.discussions.map((discussion) => (
          <button
            key={discussion.id}
            className={discussion.id === current ? 'is-current' : undefined}
            onClick={() => pick(discussion.id)}
          >
            {discussion.title}
          </button>
        ))}
        <button onClick={() => pick(null)}>＋ 新讨论</button>
      </div>
    </details>
  );
}

// A book's pages in page order, with their summaries, then its other notes.
export function BookPageList({
  bookId,
  refresh,
  onOpen,
  onNavigate,
}: {
  bookId: string;
  refresh: number;
  onOpen: (node: NoteNode) => void;
  onNavigate: (id: string) => void;
}) {
  const [list, setList] = useState<BookPages | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api<BookPages>(`/api/nodes/${bookId}/pages`)
      .then((value) => {
        if (live) {
          setList(value);
          setError('');
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [bookId, refresh]);
  if (!list)
    return error ? <p className="inline-error">{error}</p> : <Spinner label="正在读取页面…" />;
  return (
    <div className="book-page-list">
      <div className="page-insights-heading">
        <span>页面（{list.pages.length}）</span>
        <span>按页码</span>
      </div>
      {!list.pages.length && <p className="muted-text">还没有页面，点上方「拍照添加页面」。</p>}
      {list.pages.map((page) => (
        <button key={page.id} className="book-page-row" onClick={() => onNavigate(page.id)}>
          <span className="book-page-number">{page.page ?? '·'}</span>
          <span>
            <strong>{page.title}</strong>
            {page.summary && <small>{page.summary}</small>}
            {(page.discussions > 0 || page.note_id) && (
              <span className="book-page-chips">
                {page.discussions > 0 && <em>{page.discussions} 个讨论</em>}
                {page.note_id && <em className="is-note">读书笔记</em>}
              </span>
            )}
          </span>
        </button>
      ))}
      {list.others.length > 0 && (
        <>
          <div className="page-insights-heading">
            <span>笔记</span>
          </div>
          {list.others.map((node) => (
            <button key={node.id} className="book-page-row" onClick={() => onOpen(node)}>
              <span className="book-page-number">
                <NodeIcon node={node} kind={node.arxiv_id ? 'arxiv' : node.kind} size={18} />
              </span>
              <span>
                <strong>{node.title}</strong>
              </span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}
