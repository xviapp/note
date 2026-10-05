import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, List, X } from 'lucide-react';
import { api, fileUrl } from '../api';
import type { NoteDetail, NoteNode } from '../../shared/types';
import { splittable } from '../split';
import type { Heading } from './MarkdownView';
import { NoteBody } from './NoteBody';
import { CachedImage } from './CachedImage';
import { Spinner } from './Primitives';
import { SearchDialog } from './SearchDialog';

const PdfView = lazy(() => import('./PdfView'));

const narrow = () => matchMedia('(max-width: 760px)').matches;

// One side of the split: its own scroll position and outline. A PDF keeps the
// reader's own toolbar, outline included.
function SplitPane({ note, onReplace }: { note: NoteDetail | null; onReplace: () => void }) {
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
        <strong title={note?.title}>{note?.title ?? '选择一份文件'}</strong>
        {!pdf && headings.length > 0 && (
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
        <button className="button compact" onClick={onReplace}>
          <ArrowLeftRight size={15} />
          {note ? '换一份' : '选择文件'}
        </button>
      </header>
      <div className="split-pane-body">
        {tocOpen && (
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
        {!note ? (
          <div className="split-empty">
            <button className="button primary" onClick={onReplace}>
              选择要并排查看的文件
            </button>
          </div>
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
    [picking, setPicking] = useState<0 | 1 | null>(null),
    [side, setSide] = useState<0 | 1>(0),
    [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    // The picker opens only now: a modal shown earlier would sit beneath this
    // one, out of sight and out of reach.
    setPicking(1);
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
            onReplace={() => setPicking(index as 0 | 1)}
          />
        ))}
      </div>
      {picking !== null && (
        <SearchDialog
          title={picking ? '选择右侧文件' : '选择左侧文件'}
          accept={splittable}
          onOpen={(node) => void choose(picking, node)}
          onClose={() => setPicking(null)}
        />
      )}
    </dialog>
  );
}
