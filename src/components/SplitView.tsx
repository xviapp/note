import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, ChevronRight, List, Search, X } from 'lucide-react';
import { api, fileUrl } from '../api';
import type { NoteDetail, NoteNode, SearchResult } from '../../shared/types';
import { splittable } from '../split';
import type { Heading } from './MarkdownView';
import { NoteBody } from './NoteBody';
import { NodeList } from './NodeList';
import { CachedImage } from './CachedImage';
import { NodeIcon, Spinner } from './Primitives';

const PdfView = lazy(() => import('./PdfView'));

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
            setResults(data.results.filter((node) => node.kind === 'folder' || splittable(node)));
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
function SplitPane({
  note,
  picking,
  onReplace,
  onPick,
  onCancelPick,
}: {
  note: NoteDetail | null;
  picking: boolean;
  onReplace: () => void;
  onPick: (node: NoteNode) => void;
  onCancelPick: () => void;
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
  return (
    <section className="split-pane" aria-label={note ? note.title : '未选择文件'}>
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
          <Suspense fallback={<Spinner label="正在打开 PDF…" />}>
            <PdfView key={note.file!.id} fileId={note.file!.id} cacheNote={note} />
          </Suspense>
        ) : note.kind === 'image' && note.file ? (
          <div className="split-scroll split-image">
            <CachedImage src={fileUrl(note.file.id)} alt={note.title} />
          </div>
        ) : (
          <div ref={scroll} className="split-scroll">
            <article className="note-article">
              <h1 className="split-title">{note.title}</h1>
              <NoteBody
                note={note}
                editing={false}
                content={note.content}
                onNavigate={() => {}}
                onImage={() => {}}
                onHeadings={setHeadings}
              />
            </article>
          </div>
        )}
      </div>
    </section>
  );
}

// Two notes side by side, full screen. Each side scrolls on its own and has its
// own outline; either can be swapped for another file. Phones show one side
// at a time.
export default function SplitView({ first, onClose }: { first: NoteDetail; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [notes, setNotes] = useState<[NoteDetail | null, NoteDetail | null]>([first, null]),
    // The empty right side starts out listing files to choose from.
    [picking, setPicking] = useState<0 | 1 | null>(1),
    // Phones start on the right: the left is the note already open.
    [side, setSide] = useState<0 | 1>(1),
    [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => element?.close();
  }, []);
  const choose = async (index: 0 | 1, node: NoteNode) => {
    setPicking(null);
    setError('');
    try {
      const detail = await api<NoteDetail>(`/api/nodes/${node.id}`);
      setNotes((current) => {
        const next: typeof current = [...current];
        next[index] = detail;
        return next;
      });
      setSide(index);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <dialog
      ref={dialog}
      className={`compare-view split-view show-${side}`}
      aria-label="分屏查看"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
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
        <button className="icon-button compare-close" aria-label="关闭分屏" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      {error && (
        <p className="compare-error" role="alert">
          {error}
        </p>
      )}
      <div className="split-body">
        {notes.map((note, index) => (
          <SplitPane
            // A new file starts a fresh pane: its own outline and scroll position.
            key={`${index}-${note?.id ?? ''}`}
            note={note}
            picking={picking === index}
            onReplace={() => setPicking(index as 0 | 1)}
            onPick={(node) => void choose(index as 0 | 1, node)}
            onCancelPick={() => setPicking(null)}
          />
        ))}
      </div>
    </dialog>
  );
}
