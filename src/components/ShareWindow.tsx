import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { ExternalLink, Files, Globe, X } from 'lucide-react';
import { api, ApiError, formatBytes } from '../api';
import { importPaper } from '../arxiv-import';
import { classifyShare, type ShareClass, type ShareKind } from '../share-kind';
import {
  importShare,
  incomingShareFilePath,
  isTextFile,
  type IncomingShare,
} from '../shared-import';
import { device } from '../mobile';
import { useOffline } from '../connectivity';
import type { ArxivPreview, AuthStatus, NodeKind } from '../../shared/types';
import { NodeIcon } from './Primitives';
import { NodePicker } from './Tree';
import { useShareDestination } from '../use-share-destination';
import { addClip, flushClips } from '../clips';

const MarkdownView = lazy(() =>
  import('./MarkdownView').then((module) => ({ default: module.MarkdownView })),
);

const LABELS: Record<ShareKind, string> = {
  arxiv: 'arXiv 论文',
  link: '网页链接',
  markdown: 'Markdown',
  text: '纯文本',
  pdf: 'PDF',
  image: '图片',
  files: '文件',
};
const ICONS: Record<Exclude<ShareKind, 'files'>, NodeKind | 'paper'> = {
  arxiv: 'paper',
  link: 'link',
  markdown: 'markdown',
  text: 'text',
  pdf: 'pdf',
  image: 'image',
};

// The floating window Android opens over the app a share came from. It shows
// the share by kind, saves it, and closes back to that app.
export default function ShareWindow() {
  const [share, setShare] = useState<IncomingShare | null>(null);
  const [auth, setAuth] = useState<'checking' | 'in' | 'out'>('checking');
  const [kind, setKind] = useState<ShareClass | null>(null);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  // Markdown and plain text can be saved as each other.
  const [format, setFormat] = useState<'markdown' | 'text'>('markdown');
  const [preview, setPreview] = useState(false);
  const [paperMode, setPaperMode] = useState<'import' | 'link'>('import');
  const [paper, setPaper] = useState<ArxivPreview | null>(null);
  const [paperError, setPaperError] = useState('');

  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const edited = useRef(false);
  const resume = useRef<string | null>(null);
  const offline = useOffline();
  const { destination, parent, error: destinationError, retry: retryDestination, select: selectDestination } =
    useShareDestination(share?.id ?? null, auth === 'in' && !offline);

  useEffect(() => {
    let live = true;
    const load = () =>
      device
        .getPendingShare()
        .then(({ share }) => {
          if (!live || !share) return;
          setShare((current) => current ?? share);
        })
        .catch(() => {});
    void load();
    window.addEventListener('note:share', load);
    api<AuthStatus>('/api/auth/status')
      .then((status) => live && setAuth(status.authenticated ? 'in' : 'out'))
      .catch(() => live && setAuth('in'));
    return () => {
      live = false;
      window.removeEventListener('note:share', load);
    };
  }, []);

  // Classify once the share arrives; a text file's content becomes the body.
  useEffect(() => {
    if (!share) return;
    const found = classifyShare(share);
    setKind(found);
    setTitle(found.title);
    setText(share.text ?? '');
    setFormat(found.kind === 'text' ? 'text' : 'markdown');
    const textFile = share.files.length === 1 && isTextFile(share.files[0]!) && share.files[0]!;
    if (textFile)
      fetch(incomingShareFilePath(share, textFile))
        .then((response) => {
          if (!response.ok) throw new Error();
          return response.text();
        })
        .then(setText)
        .catch(() => setMessage('无法读取分享的文件，请重新分享。'));
  }, [share]);

  useEffect(() => {
    if (kind?.kind !== 'arxiv' || auth !== 'in' || offline) return;
    let live = true;
    setPaperError('');
    api<ArxivPreview>(`/api/import/arxiv/preview?url=${encodeURIComponent(kind.url!)}`)
      .then((result) => {
        if (!live) return;
        setPaper(result);
        if (!edited.current) setTitle(result.title);
      })
      .catch((error) => live && setPaperError((error as Error).message));
    return () => {
      live = false;
    };
  }, [kind, auth, offline]);



  const close = (options: { saved?: boolean; openApp?: boolean } = {}) =>
    void device.closeShare(options).catch(() => {});
  const cancel = () => {
    if (!busy) close();
  };
  useEffect(() => {
    const back = (event: Event) => {
      event.preventDefault();
      cancel();
    };
    window.addEventListener('note:native-back', back);
    return () => window.removeEventListener('note:native-back', back);
  });

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!share || !kind || busy || offline || !destination) return;
    setBusy(true);
    setMessage('');
    try {
      if (kind.kind === 'arxiv' && paperMode === 'import') {
        await importPaper(
          { title: title.trim(), parentId: parent, url: kind.url! },
          `share-arxiv-${share.id}`,
          resume,
          (progress) => setMessage(`正在导入论文图片 ${progress.done}/${progress.total}…`),
        );
      } else {
        const link = kind.kind === 'arxiv' || kind.kind === 'link';
        await importShare(
          share,
          {
            title: title.trim() || paper?.title || '',
            text: link ? kind.url! : text,
            parent,
            format: link ? 'link' : format,
          },
          setMessage,
        );
      }
      close({ saved: true });
    } catch (error) {
      setMessage(
        error instanceof ApiError && error.status === 401
          ? '登录已失效，请打开页间重新登录。'
          : (error as Error).message,
      );
      setBusy(false);
    }
  }

  // Text, links and a single image can go to 随手记 instead. Text works
  // offline too (the notebook sends it later); an image is uploaded now.
  async function clip() {
    if (!share || !kind || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const link = kind.kind === 'arxiv' || kind.kind === 'link';
      const heading = title.trim() || paper?.title || '';
      if (kind.kind === 'image') {
        const file = share.files[0]!;
        const response = await fetch(incomingShareFilePath(share, file));
        if (!response.ok) throw new Error('无法读取分享的图片，请重新分享。');
        const image = Object.assign(await response.blob(), { name: file.name });
        await addClip(text, null, undefined, image);
      } else await addClip(link ? (heading ? `${heading}\n${kind.url}` : kind.url!) : text);
      if (!offline) await flushClips();
      close({ saved: true });
    } catch (error) {
      setMessage((error as Error).message);
      setBusy(false);
    }
  }

  const ready = !!share && !!kind;
  const textual = kind?.kind === 'markdown' || kind?.kind === 'text';
  const needsTitle = !(kind?.kind === 'arxiv' && paperMode === 'import');
  const canSave =
    ready &&
    auth === 'in' &&
    !offline &&
    !share.error &&
    !!destination &&
    (!needsTitle || !!title.trim() || !!paper?.title) &&
    (!textual || !!text.trim());

  return (
    <div className="share-window">
      <button
        type="button"
        className="share-window-scrim"
        aria-label="取消保存"
        tabIndex={-1}
        onClick={cancel}
      />
      <form
        className="share-window-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="保存到页间"
        onSubmit={(event) => void save(event)}
      >
        <header className="share-window-header">
          <span className="share-kind" data-kind={kind?.kind}>
            {kind &&
              (kind.kind === 'files' ? (
                <Files size={15} />
              ) : (
                <NodeIcon kind={ICONS[kind.kind]} size={15} />
              ))}
            {kind ? LABELS[kind.kind] : '分享'}
          </span>
          <h1>保存到页间</h1>
          <button type="button" className="icon-button" aria-label="关闭" onClick={cancel}>
            <X size={18} />
          </button>
        </header>
        {!ready ? (
          <p className="share-window-status" role="status">
            正在读取分享内容…
          </p>
        ) : share.error ? (
          <p className="inline-error" role="alert">
            {share.error}
          </p>
        ) : auth === 'out' ? (
          <div className="share-window-status">
            <p>登录页间后才能保存，分享内容会在页间里等你。</p>
            <button type="button" className="button" onClick={() => close({ openApp: true })}>
              <ExternalLink size={15} />
              打开页间登录
            </button>
          </div>
        ) : (
          <div className="share-window-body">
            {kind.kind === 'arxiv' && (
              <ArxivCard
                id={kind.arxivId!}
                paper={paper}
                error={paperError}
                mode={paperMode}
                onMode={setPaperMode}
              />
            )}
            {kind.kind === 'link' && (
              <a className="share-link" href={kind.url} onClick={(event) => event.preventDefault()}>
                <Globe size={16} />
                <span>
                  <strong>{new URL(kind.url!).hostname.replace(/^www\./, '')}</strong>
                  <small>{kind.url}</small>
                </span>
              </a>
            )}
            {kind.kind === 'pdf' && (
              <PdfSummary
                share={share}
                onTitle={(value) => {
                  if (!edited.current) setTitle(value);
                }}
              />
            )}
            {kind.kind === 'image' && <ImageGrid share={share} />}
            {kind.kind === 'files' && (
              <ul className="share-file-list">
                {share.files.map((file) => (
                  <li key={file.id}>
                    <NodeIcon kind={file.mime === 'application/pdf' ? 'pdf' : 'image'} size={15} />
                    <span>{file.name}</span>
                    <small>{formatBytes(file.size)}</small>
                  </li>
                ))}
              </ul>
            )}
            <label>
              标题
              <input
                value={title}
                maxLength={200}
                disabled={busy}
                placeholder={kind.kind === 'arxiv' ? '留空使用论文标题' : undefined}
                onChange={(e) => {
                  edited.current = true;
                  setTitle(e.target.value);
                }}
              />
            </label>
            {kind.kind === 'image' && share.files.length > 1 && (
              <p className="field-hint">
                将保存为 {share.files.length} 条图片笔记，各用文件名作标题。
              </p>
            )}
            {textual && (
              <div className="share-text">
                <div className="share-text-tabs" role="group" aria-label="正文格式">
                  <button
                    type="button"
                    aria-pressed={format === 'markdown'}
                    disabled={busy}
                    onClick={() => setFormat('markdown')}
                  >
                    Markdown
                  </button>
                  <button
                    type="button"
                    aria-pressed={format === 'text'}
                    disabled={busy}
                    onClick={() => {
                      setFormat('text');
                      setPreview(false);
                    }}
                  >
                    纯文本
                  </button>
                  {format === 'markdown' && (
                    <button
                      type="button"
                      className="share-preview-toggle"
                      aria-pressed={preview}
                      onClick={() => setPreview((value) => !value)}
                    >
                      {preview ? '编辑' : '预览'}
                    </button>
                  )}
                </div>
                {preview && format === 'markdown' ? (
                  <div className="share-markdown read-content">
                    <Suspense fallback={<p role="status">正在加载预览…</p>}>
                      <MarkdownView
                        content={text}
                        safeImages
                        onNavigate={() => {}}
                        onImage={() => {}}
                      />
                    </Suspense>
                  </div>
                ) : (
                  <textarea
                    aria-label="正文"
                    value={text}
                    disabled={busy}
                    rows={8}
                    onChange={(e) => setText(e.target.value)}
                  />
                )}
              </div>
            )}
            {!textual && kind.kind !== 'link' && kind.kind !== 'arxiv' && !!share.text?.trim() && (
              <label>
                附言
                <textarea
                  aria-label="附言"
                  value={text}
                  disabled={busy}
                  rows={3}
                  onChange={(e) => setText(e.target.value)}
                />
              </label>
            )}
            <div className="share-destination">
              <span>
                保存到：<strong>{destination?.title ?? '…'}</strong>
              </span>
              <button
                type="button"
                className="text-button"
                disabled={busy || !destination}
                aria-expanded={choosing}
                onClick={() => setChoosing((value) => !value)}
              >
                {choosing ? '完成' : '更改'}
              </button>
            </div>
            {destinationError && !offline && (
              <div>
                <p className="inline-error" role="alert">{destinationError}</p>
                <button type="button" className="text-button" onClick={retryDestination}>重新加载保存目录</button>
              </div>
            )}
            {choosing && destination && (
              <NodePicker
                value={parent}
                parentsOnly
                initialPath={destination.path}
                onSelect={selectDestination}
              />
            )}
          </div>
        )}
        {offline && <p role="status">联网后可以保存。</p>}
        {message && (
          <p className="share-window-message" role="status">
            {message}
          </p>
        )}
        <footer className="dialog-actions">
          <button type="button" className="button" disabled={busy} onClick={cancel}>
            取消
          </button>
          {ready && !share.error && auth === 'in' && kind.kind !== 'files' && kind.kind !== 'pdf' && (kind.kind !== 'image' || share.files.length === 1) && (
            <button
              type="button"
              className="button"
              disabled={busy || (textual && !text.trim())}
              onClick={() => void clip()}
            >
              存入随手记
            </button>
          )}
          <button type="submit" className="button primary" disabled={!canSave || busy}>
            {busy ? '保存中…' : kind?.kind === 'arxiv' && paperMode === 'import' ? '导入' : '保存'}
          </button>
        </footer>
      </form>
    </div>
  );
}

function ArxivCard({
  id,
  paper,
  error,
  mode,
  onMode,
}: {
  id: string;
  paper: ArxivPreview | null;
  error: string;
  mode: 'import' | 'link';
  onMode: (mode: 'import' | 'link') => void;
}) {
  const authors = paper?.authors ?? [];
  return (
    <section className="share-paper" aria-label="论文信息">
      <small>arXiv:{id}</small>
      {paper ? (
        <>
          <strong>{paper.title}</strong>
          {authors.length > 0 && (
            <span className="share-paper-authors">
              {authors.slice(0, 3).join('、')}
              {authors.length > 3 ? ` 等 ${authors.length} 人` : ''}
            </span>
          )}
          {paper.summary && <p>{paper.summary}</p>}
        </>
      ) : (
        <span className="field-hint">{error || '正在读取论文信息…'}</span>
      )}
      <div className="share-text-tabs" role="radiogroup" aria-label="保存方式">
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'import'}
          aria-pressed={mode === 'import'}
          onClick={() => onMode('import')}
        >
          导入全文
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'link'}
          aria-pressed={mode === 'link'}
          onClick={() => onMode('link')}
        >
          只存链接
        </button>
      </div>
    </section>
  );
}

function ImageGrid({ share }: { share: IncomingShare }) {
  const single = share.files.length === 1;
  return (
    <ul className={`share-images${single ? ' is-single' : ''}`}>
      {share.files.map((file) => {
        let path = '';
        try {
          path = incomingShareFilePath(share, file);
        } catch {
          // The import reports an invalid payload before saving anything.
        }
        const shown = path && /^image\/(png|jpeg|gif|webp|avif)$/.test(file.mime);
        return (
          <li key={file.id}>
            {shown ? <img src={path} alt={file.name} /> : <NodeIcon kind="image" size={28} />}
            {!single && <span>{file.name}</span>}
          </li>
        );
      })}
    </ul>
  );
}

// The first page, page count and size, read locally before anything is uploaded.
function PdfSummary({
  share,
  onTitle,
}: {
  share: IncomingShare;
  onTitle: (title: string) => void;
}) {
  const file = share.files[0]!;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pages, setPages] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const titled = useRef(onTitle);
  titled.current = onTitle;
  useEffect(() => {
    let live = true;
    let destroy = () => {};
    (async () => {
      const response = await fetch(incomingShareFilePath(share, file));
      if (!response.ok) throw new Error();
      const data = new Uint8Array(await response.arrayBuffer());
      const { openPdf } = await import('../pdf-document');
      const task = openPdf(data);
      destroy = () => void task.destroy().catch(() => {});
      const pdf = await task.promise;
      if (!live) return;
      setPages(pdf.numPages);
      const info = (await pdf.getMetadata().catch(() => null))?.info as
        { Title?: string } | undefined;
      const documentTitle = info?.Title?.trim();
      // Word exports often carry their file name as the title; skip those.
      if (
        live &&
        documentTitle &&
        documentTitle.length > 3 &&
        !/^microsoft|\.docx?$/i.test(documentTitle)
      )
        titled.current(documentTitle.slice(0, 200));
      const page = await pdf.getPage(1);
      const element = canvas.current;
      if (!live || !element) return;
      const base = page.getViewport({ scale: 1 });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: (88 * ratio) / base.width });
      element.width = Math.ceil(viewport.width);
      element.height = Math.ceil(viewport.height);
      await page.render({ canvas: element, canvasContext: element.getContext('2d')!, viewport })
        .promise;
    })().catch(() => live && setFailed(true));
    return () => {
      live = false;
      destroy();
    };
    // One share, one file: read it once.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="share-pdf">
      <canvas ref={canvas} aria-label="PDF 第一页" hidden={failed} />
      <span>
        <strong>{file.name}</strong>
        <small>
          {pages ? `${pages} 页 · ` : failed ? '无法预览 · ' : ''}
          {formatBytes(file.size)}
        </small>
      </span>
    </div>
  );
}
