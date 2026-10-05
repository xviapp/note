import { lazy, Suspense, useEffect, useRef, useState, type RefObject } from 'react';
import { ArrowLeftRight, ChevronRight, List, Search, X } from 'lucide-react';
import { api, fileUrl } from '../api';
import type { NoteDetail, NoteNode, SearchResult } from '../../shared/types';
import { splittable } from '../split';
import type { Heading } from './MarkdownView';
import { NoteBody } from './NoteBody';
import { NodeList } from './NodeList';
import { CachedImage } from './CachedImage';
import { NodeIcon, Spinner } from './Primitives';
import { useReading } from '../useReading';
import { useAssistantHost } from '../assistant-host';
import type { TranslationLaunch } from '../translation';
import { SelectionToolbar } from './SelectionToolbar';
import { TranslationPanel } from './TranslationPanel';
import { useAnnotations, type AnnotationStore } from '../annotations';
import { useAnnotationLayer } from '../use-annotation-layer';
import { useOffline } from '../connectivity';
import { TEXT_KINDS } from '../../shared/types';

const PdfView = lazy(() => import('./PdfView'));
const ImageViewer = lazy(() => import('./ImageViewer'));
// The file last shown beside a note, to pair them again next time.
const PAIR_KEY = (id: string) => `split-pair:${id}`;
const SYNC_KEY = 'split-sync';

// A PDF resumes where it was last read and keeps recording progress.
function SplitPdf({
  note,
  annotations,
  onAnnotation,
}: {
  note: NoteDetail;
  annotations: AnnotationStore;
  onAnnotation: (id: string) => void;
}) {
  const reading = useReading(note.id);
  if (!reading.initial) return <Spinner label="正在打开 PDF…" />;
  return (
    <Suspense fallback={<Spinner label="正在打开 PDF…" />}>
      <PdfView
        key={note.file!.id}
        fileId={note.file!.id}
        cacheNote={note}
        initialPosition={reading.initial}
        onPosition={reading.update}
        annotations={annotations.list}
        onAnnotation={onAnnotation}
      />
    </Suspense>
  );
}

const narrow = () => matchMedia('(max-width: 760px)').matches;

// Choosing a file inside the pane: the library's folders to step through, or a
// title search. Only files the split can show are picked; folders open.
function FilePicker({
  onPick,
  onCancel,
}: {
  onPick: (node: NoteNode) => void;
  onCancel?: () => void;
}) {
  const [path, setPath] = useState<{ id: string; title: string }[]>([]),
    [query, setQuery] = useState(''),
    [results, setResults] = useState<SearchResult[] | null>(null),
    [message, setMessage] = useState('');
  useEffect(() => {
    const term = query.trim();
    if (!term) {
      setResults(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      api<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(term)}`)
        .then((data) => {
          if (live)
            setResults(
              data.results.filter(
                (node) => !node.annotation && (node.kind === 'folder' || splittable(node)),
              ),
            );
        })
        .catch((e) => live && setMessage((e as Error).message));
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);
  const open = (node: NoteNode) => {
    setMessage('');
    if (node.kind === 'folder') {
      setQuery('');
      setPath((current) => [...current, { id: node.id, title: node.title }]);
    } else if (splittable(node)) onPick(node);
    else setMessage('网页链接无法分屏查看，请选择笔记、论文、PDF 或图片。');
  };
  const parent = path.at(-1)?.id ?? null;
  return (
    <div className="split-picker">
      <div className="split-picker-bar">
        <nav className="split-picker-path" aria-label="当前位置">
          <button onClick={() => setPath([])} disabled={!path.length}>
            全部笔记
          </button>
          {path.map((part, index) => (
            <span key={part.id}>
              <ChevronRight size={13} aria-hidden="true" />
              <button
                onClick={() => setPath((current) => current.slice(0, index + 1))}
                disabled={index === path.length - 1}
              >
                {part.title}
              </button>
            </span>
          ))}
        </nav>
        {onCancel && (
          <button className="button compact" onClick={onCancel}>
            取消
          </button>
        )}
      </div>
      <label className="search-field split-picker-search">
        <Search size={16} aria-hidden="true" />
        <input
          type="text"
          aria-label="按标题查找文件"
          placeholder="按标题查找"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {message && (
        <p className="inline-error" role="alert">
          {message}
        </p>
      )}
      <div className="split-picker-list">
        {results ? (
          results.length ? (
            <ul className="search-results">
              {results.map((node) => (
                <li key={node.id}>
                  <button className="split-picker-result" onClick={() => open(node)}>
                    <NodeIcon kind={node.arxiv_id ? 'arxiv' : node.kind} node={node} />
                    <span className="search-result-text">
                      <strong>{node.title}</strong>
                      {node.path.length > 0 && <small>{node.path.join(' / ')}</small>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="search-caption">没有标题匹配的文件</p>
          )
        ) : (
          <div className="node-list">
            <NodeList key={parent ?? 'root'} parent={parent} refresh={0} onOpen={open} />
          </div>
        )}
      </div>
    </div>
  );
}

// One side of the split: its own scroll position and outline. A PDF keeps the
// reader's own toolbar, outline included. While choosing, the pane lists files.
type Annotate = ReturnType<typeof useAnnotationLayer>['annotate'];
function SplitPane({
  index,
  annotators,
  onQuote,
  note,
  picking,
  onReplace,
  onPick,
  onCancelPick,
  onOpen,
  onImage,
}: {
  index: number;
  // Where the view's selection toolbar finds this side's highlighting.
  annotators: RefObject<Record<number, Annotate>>;
  onQuote: (text: string) => string | undefined;
  note: NoteDetail | null;
  picking: boolean;
  onReplace: () => void;
  onPick: (node: NoteNode) => void;
  onCancelPick: () => void;
  // A link to another note opens it in this pane.
  onOpen: (id: string) => void;
  onImage: (src: string, alt: string) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [headings, setHeadings] = useState<Heading[]>([]),
    [tocOpen, setTocOpen] = useState(false);
  const jump = (id: string) => {
    const pane = scroll.current,
      element = pane?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (pane && element)
      pane.scrollTop += element.getBoundingClientRect().top - pane.getBoundingClientRect().top;
    if (narrow()) setTocOpen(false);
  };
  const pdf = note?.kind === 'pdf' && note.file;
  // Each side shows the highlights and notes of its own file.
  const offline = useOffline();
  const annotatable =
    !!note && !picking && (TEXT_KINDS.includes(note.kind) || !!note.arxiv_id || !!pdf);
  const annotations = useAnnotations(note?.id, annotatable);
  const layer = useAnnotationLayer({
    store: annotations,
    owner: `split-${index}`,
    root: () => scroll.current?.querySelector<HTMLElement>('.read-content') ?? null,
    active: annotatable,
    offline,
    paintKey: note?.id,
    onAsk: onQuote,
  });
  useEffect(() => {
    const current = annotators.current;
    if (annotatable) current[index] = layer.annotate;
    else delete current[index];
  });
  return (
    <section
      className="split-pane"
      aria-label={note ? note.title : '未选择文件'}
      data-note-id={!picking ? note?.id : undefined}
      data-pane={index}
    >
      <header className="split-pane-header">
        <strong title={note?.title}>
          {picking ? '选择一份文件' : (note?.title ?? '选择一份文件')}
        </strong>
        {!picking && !pdf && headings.length > 0 && (
          <button
            className="icon-button toc-toggle"
            aria-label={`${note?.title ?? ''}的目录`}
            title={tocOpen ? '隐藏目录' : '显示目录'}
            aria-expanded={tocOpen}
            onClick={() => setTocOpen((open) => !open)}
          >
            <List size={18} />
          </button>
        )}
        {!picking && note && (
          <button className="button compact" onClick={onReplace}>
            <ArrowLeftRight size={15} />
            换一份
          </button>
        )}
      </header>
      <div className="split-pane-body">
        {tocOpen && !picking && (
          <nav className="toc split-toc" aria-label={`${note?.title ?? ''}的目录`}>
            {headings.map((heading) => (
              <button
                key={heading.id}
                style={{ paddingLeft: 12 + (heading.level - 1) * 10 }}
                onClick={() => jump(heading.id)}
              >
                {heading.title || '无标题'}
              </button>
            ))}
          </nav>
        )}
        {picking || !note ? (
          <FilePicker onPick={onPick} onCancel={note ? onCancelPick : undefined} />
        ) : pdf ? (
          <SplitPdf note={note} annotations={annotations} onAnnotation={layer.open} />
        ) : note.kind === 'image' && note.file ? (
          <div className="split-scroll split-image">
            <button
              className="split-image-zoom"
              aria-label={`放大图片：${note.title}`}
              onClick={() => onImage(fileUrl(note.file!.id), note.title)}
            >
              <CachedImage src={fileUrl(note.file.id)} alt={note.title} />
            </button>
          </div>
        ) : (
          <div ref={scroll} className="split-scroll" onClick={layer.onClick}>
            <article className="note-article">
              <h1 className="split-title">{note.title}</h1>
              <NoteBody
                note={note}
                editing={false}
                content={note.content}
                onNavigate={onOpen}
                onImage={onImage}
                onHeadings={setHeadings}
              />
            </article>
          </div>
        )}
      </div>
      {layer.editor}
    </section>
  );
}

const pairedWith = (id: string) => {
  try {
    return localStorage.getItem(PAIR_KEY(id));
  } catch {
    return null;
  }
};
const remember = (id: string, other: string) => {
  try {
    localStorage.setItem(PAIR_KEY(id), other);
  } catch {
    /* Storage can be unavailable; the pairing is just not kept. */
  }
};

// Two notes side by side, full screen. Each side scrolls on its own and has its
// own outline; either can be swapped for another file. Phones show one side
// at a time.
export default function SplitView({
  first,
  onClose,
  onQuote,
  onChanged,
}: {
  first: NoteDetail;
  onClose: () => void;
  // Selected text for Qingli (of the note the view was opened from), which
  // opens inside this view.
  onQuote: (text: string) => string | undefined;
  onChanged: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [notes, setNotes] = useState<[NoteDetail | null, NoteDetail | null]>([first, null]),
    // The empty right side lists files to choose from, unless a pairing is remembered.
    [picking, setPicking] = useState<0 | 1 | null>(() => (pairedWith(first.id) ? null : 1)),
    [image, setImage] = useState<{ src: string; alt: string } | null>(null),
    [sync, setSync] = useState(() => {
      try {
        return localStorage.getItem(SYNC_KEY) === 'on';
      } catch {
        return false;
      }
    }),
    // Phones start on the right: the left is the note already open.
    [side, setSide] = useState<0 | 1>(1),
    [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => element?.close();
  }, []);
  // Qingli shows inside this view while it is open.
  useAssistantHost(dialog);
  // A selection's translation is kept with the note it was selected in.
  const [translation, setTranslation] = useState<(TranslationLaunch & { nodeId: string }) | null>(
    null,
  );
  const owner = `split-${first.id}`;
  const annotators = useRef<Record<number, Annotate>>({});
  const choose = async (index: 0 | 1, id: string) => {
    setPicking(null);
    setError('');
    try {
      const detail = await api<NoteDetail>(`/api/nodes/${id}`);
      if (!splittable(detail)) {
        setError('这类内容无法分屏查看，请选择笔记、论文、PDF 或图片。');
        return;
      }
      if (index === 1) remember(first.id, detail.id);
      setNotes((current) => {
        const next: typeof current = [...current];
        next[index] = detail;
        return next;
      });
      setSide(index);
    } catch (e) {
      setError((e as Error).message);
      if (index === 1 && !notes[1]) setPicking(1);
    }
  };
  // Reopen the file last paired with this note.
  useEffect(() => {
    const paired = pairedWith(first.id);
    if (paired) void choose(1, paired);
    // Only on opening.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Optional: scrolling one side moves the other to the same proportion. The
  // files differ, so they line up by position, not by paragraph.
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!sync) return;
    const root = body.current;
    if (!root) return;
    const scrollers = () =>
      Array.from(root.querySelectorAll<HTMLElement>('.split-pane')).map((pane) =>
        pane.querySelector<HTMLElement>('.split-scroll, .pdf-scroll'),
      );
    let ignore: HTMLElement | null = null;
    const onScroll = (event: Event) => {
      const from = event.target as HTMLElement;
      if (!from.matches?.('.split-scroll, .pdf-scroll')) return;
      if (ignore === from) {
        ignore = null;
        return;
      }
      const [a, b] = scrollers();
      const to = from === a ? b : from === b ? a : null;
      if (!to) return;
      const ratio = from.scrollTop / Math.max(1, from.scrollHeight - from.clientHeight);
      const target = ratio * (to.scrollHeight - to.clientHeight);
      if (Math.abs(to.scrollTop - target) < 1) return;
      ignore = to;
      to.scrollTop = target;
    };
    root.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => root.removeEventListener('scroll', onScroll, { capture: true });
  }, [sync, notes]);
  const toggleSync = (value: boolean) => {
    setSync(value);
    try {
      localStorage.setItem(SYNC_KEY, value ? 'on' : 'off');
    } catch {
      /* Storage can be unavailable; the choice still applies now. */
    }
  };
  return (
    <dialog
      ref={dialog}
      className={`compare-view split-view show-${side}`}
      aria-label="分屏查看"
      onCancel={(event) => {
        event.preventDefault();
        // Escape in a dialog opened inside this view (an enlarged image, the
        // glossary) reaches this handler too; only this view's own closes it.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header className="compare-header split-header">
        <h2>分屏查看</h2>
        <div className="compare-sides" role="group" aria-label="显示">
          {notes.map((note, index) => (
            <button
              key={index}
              className={side === index ? 'active' : ''}
              onClick={() => setSide(index as 0 | 1)}
            >
              {index ? '右' : '左'}
              {note ? `：${note.title}` : ''}
            </button>
          ))}
        </div>
        <label className="compare-auto split-sync" title="按比例同步两侧的滚动位置">
          <input
            type="checkbox"
            checked={sync}
            onChange={(event) => toggleSync(event.target.checked)}
          />
          同步滚动
        </label>
        <button className="icon-button compare-close" aria-label="关闭分屏" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      {error && (
        <p className="compare-error" role="alert">
          {error}
        </p>
      )}
      <div className="split-body" ref={body} data-selection-owner={owner}>
        {notes.map((note, index) => (
          <SplitPane
            // A new file starts a fresh pane: its own outline and scroll position.
            key={`${index}-${note?.id ?? ''}`}
            index={index}
            annotators={annotators}
            onQuote={onQuote}
            note={note}
            picking={picking === index}
            onReplace={() => setPicking(index as 0 | 1)}
            onPick={(node) => void choose(index as 0 | 1, node.id)}
            onCancelPick={() => setPicking(null)}
            onOpen={(id) => void choose(index as 0 | 1, id)}
            onImage={(src, alt) => setImage({ src, alt })}
          />
        ))}
      </div>
      <SelectionToolbar
        owner={owner}
        onSelection={() => {}}
        onQuote={onQuote}
        onTranslate={(launch) => {
          const anchor = window.getSelection()?.anchorNode;
          const element = anchor instanceof Element ? anchor : anchor?.parentElement;
          const nodeId = element?.closest<HTMLElement>('[data-note-id]')?.dataset.noteId;
          if (nodeId) setTranslation({ ...launch, nodeId });
        }}
        onAnnotate={(selection, withNote) => {
          const anchor = window.getSelection()?.anchorNode;
          const element = anchor instanceof Element ? anchor : anchor?.parentElement;
          const pane = Number(element?.closest<HTMLElement>('[data-pane]')?.dataset.pane);
          const annotate = annotators.current[pane];
          return annotate ? annotate(selection, withNote) : '这里的文字不能批注。';
        }}
      />
      {translation && (
        <TranslationPanel
          key={translation.nodeId}
          nodeId={translation.nodeId}
          launch={translation}
          onClose={() => setTranslation(null)}
          onChanged={onChanged}
          onQuote={onQuote}
          onLocate={() => '分屏查看中无法定位原文，请在笔记页面查看。'}
          onNavigate={() => {}}
          onImage={(src, alt) => setImage({ src, alt })}
        />
      )}
      {image && (
        <Suspense fallback={null}>
          <ImageViewer {...image} onClose={() => setImage(null)} />
        </Suspense>
      )}
    </dialog>
  );
}
