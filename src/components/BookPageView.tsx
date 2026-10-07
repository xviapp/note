import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { readDraft, removeDraft, writeDraft } from '../note-drafts';
import { ChevronLeft, ChevronRight, FileText, List, MessagesSquare, RefreshCw, Send } from 'lucide-react';
import { api } from '../api';
import type { BookPageInfo, BookPages, NoteNode } from '../../shared/types';
import { Modal, NodeIcon, Spinner } from './Primitives';

// The book's saved pages, reachable from any page without returning to its folder.
export function BookContents({ bookId, title, current, refresh, onNavigate }: {
  bookId: string;
  title: string;
  current: string;
  refresh: number;
  onNavigate: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<BookPages | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setList(null);
    setError('');
    void api<BookPages>(`/api/nodes/${bookId}/pages`).then((value) => {
      if (live) setList(value);
    }).catch((cause: unknown) => {
      if (live) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { live = false; };
  }, [open, bookId, refresh, retry]);
  const navigate = (id: string) => { setOpen(false); onNavigate(id); };
  return <>
    <button className="text-button" onClick={() => setOpen(true)} aria-label="书内目录"><List size={16} /><span>书内目录</span></button>
    {open && <Modal title="书内目录" onClose={() => setOpen(false)}>
      <p className="book-contents-title">《{title}》</p>
      {error ? <div className="form-stack"><p className="inline-error" role="alert">{error}</p><button className="button compact" onClick={() => setRetry((value) => value + 1)}>重试加载目录</button></div>
        : !list ? <Spinner label="正在读取目录…" />
        : <nav className="book-contents-list" aria-label="书籍页面">
          {!list.pages.length && <p className="muted-text">还没有书页，可返回书籍添加页面。</p>}
          {list.pages.map((item) => <button key={item.id} className="book-page-row" aria-current={item.id === current ? 'page' : undefined} onClick={() => navigate(item.id)}>
            <span className="book-page-number">{item.page ?? '·'}</span>
            <span><strong>{item.title}</strong>{item.id === current && <small>当前页</small>}</span>
          </button>)}
        </nav>}
      <div className="dialog-actions"><button className="button" onClick={() => navigate(bookId)}>返回书籍</button><button className="button primary" onClick={() => setOpen(false)}>关闭</button></div>
    </Modal>}
  </>;
}

// Turning pages within the book.
export function BookPageNav({
  info,
  onNavigate,
  toolbar = false,
}: {
  info: BookPageInfo;
  onNavigate: (id: string) => void;
  // Arrows in the toolbar on wide screens; a pager below the page otherwise.
  toolbar?: boolean;
}) {
  if (!toolbar)
    return (
      <nav className="book-pager" aria-label="翻页">
        <button
          className="button compact"
          disabled={!info.prev}
          onClick={() => info.prev && onNavigate(info.prev)}
        >
          <ChevronLeft size={16} />
          <span>上一页</span>
        </button>
        <button
          className="button compact"
          disabled={!info.next}
          onClick={() => info.next && onNavigate(info.next)}
        >
          <span>下一页</span>
          <ChevronRight size={16} />
        </button>
      </nav>
    );
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

// "Ask about this page" at the foot of a book page. It grows with the question
// and keeps unsent text on this device, like the other composers.
export function PageAskBar({
  id,
  keyId,
  offline,
  onAsk,
}: {
  id: string;
  keyId?: string | null;
  offline: boolean;
  onAsk: (question: string) => void;
}) {
  const [text, setText] = useState('');
  const [ready, setReady] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const draftId = `ask:${id}`;
  // Mounted once per page (keyed by it), so a draft never moves between pages.
  useEffect(() => {
    let live = true;
    void readDraft(draftId).then((draft) => {
      if (!live) return;
      setText(draft?.content ?? '');
      setReady(true);
    });
    return () => {
      live = false;
    };
  }, [draftId]);
  useEffect(() => {
    if (!ready) return;
    if (text) writeDraft(draftId, { content: text, attachments: [], revision: 0, savedAt: Date.now() }, keyId);
    else removeDraft(draftId);
  }, [draftId, keyId, ready, text]);
  // Fit the field to its text, up to the height set in CSS.
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = '';
    element.style.height = `${element.scrollHeight + element.offsetHeight - element.clientHeight}px`;
  }, [text]);
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (offline || !text.trim()) return;
    // Put the keyboard away so 青藜 opens at its usual size.
    field.current?.blur();
    onAsk(text.trim());
    setText('');
  };
  return (
    <div className="quick-append-footer">
      <form className="page-ask" onSubmit={submit}>
        <textarea
          ref={field}
          rows={1}
          value={text}
          maxLength={8000}
          placeholder="就这一页提问，青藜会开一个新讨论…"
          aria-label="就这一页提问"
          disabled={offline || !ready}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter asks; Shift+Enter starts a new line.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button className="button primary compact" aria-label="提问" disabled={offline || !text.trim()}>
          <Send size={15} />
          <span className="page-ask-label">提问</span>
        </button>
      </form>
      {offline && <small className="page-ask-hint">联网后可以提问</small>}
    </div>
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
                <NodeIcon node={node} size={18} />
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
