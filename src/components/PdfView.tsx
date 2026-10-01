import { useEffect, useRef, useState } from 'react';
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
  type RenderTask,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { ChevronLeft, ChevronRight, Minus, Plus, Download } from 'lucide-react';
import { fileUrl } from '../api';
import { Spinner } from './Primitives';
GlobalWorkerOptions.workerSrc = workerUrl;

export default function PdfView({
  fileId,
  initialPage = 1,
  onPage,
}: {
  fileId: string;
  initialPage?: number;
  onPage?: (page: number) => void;
}) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null),
    [page, setPage] = useState(initialPage),
    [zoom, setZoom] = useState(1),
    [error, setError] = useState(''),
    [rendering, setRendering] = useState(false),
    [width, setWidth] = useState(600);
  const canvas = useRef<HTMLCanvasElement>(null),
    container = useRef<HTMLDivElement>(null),
    active = useRef<RenderTask | null>(null),
    onPageRef = useRef(onPage);
  onPageRef.current = onPage;
  useEffect(() => {
    let live = true;
    setError('');
    setDocument(null);
    const task = getDocument({
      url: fileUrl(fileId),
      withCredentials: true,
      cMapUrl: '/pdf/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdf/standard_fonts/',
      wasmUrl: '/pdf/wasm/',
    });
    task.promise
      .then((pdf) => {
        if (live) {
          setDocument(pdf);
          setPage(Math.min(pdf.numPages, Math.max(1, initialPage)));
        }
      })
      .catch((e) => {
        if (live)
          setError(
            e?.name === 'PasswordException'
              ? '这个 PDF 需要额外的文件密码，请下载后打开。'
              : 'PDF 暂时无法打开，请重试或下载文件。',
          );
      });
    return () => {
      live = false;
      active.current?.cancel();
      void task.destroy();
    };
  }, [fileId]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.max(180, entries[0].contentRect.width - 32)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!document || !canvas.current) return;
    let live = true;
    const previous = active.current;
    previous?.cancel();
    setRendering(true);
    void (async () => {
      await previous?.promise.catch(() => {});
      const pdfPage = await document.getPage(page);
      if (!live || !canvas.current) return;
      const initial = pdfPage.getViewport({ scale: 1 }),
        scale = Math.min(width / initial.width, 1.8) * zoom,
        viewport = pdfPage.getViewport({ scale }),
        ratio = Math.min(window.devicePixelRatio || 1, 2),
        element = canvas.current;
      element.width = Math.ceil(viewport.width * ratio);
      element.height = Math.ceil(viewport.height * ratio);
      element.style.width = `${viewport.width}px`;
      element.style.height = `${viewport.height}px`;
      const task = pdfPage.render({
        canvas: element,
        canvasContext: element.getContext('2d')!,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      });
      active.current = task;
      await task.promise;
      if (live) setRendering(false);
    })().catch((e) => {
      if (live && e?.name !== 'RenderingCancelledException') {
        setError('页面渲染失败，请尝试其他页码或下载文件。');
        setRendering(false);
      }
    });
    return () => {
      live = false;
      active.current?.cancel();
    };
  }, [document, page, zoom, width]);
  const move = (value: number) => {
    if (!document) return;
    const next = Math.max(1, Math.min(document.numPages, value));
    setPage(next);
    onPageRef.current?.(next);
  };
  return (
    <div className="pdf-view" ref={container}>
      <div className="pdf-toolbar">
        <button
          className="icon-button"
          aria-label="上一页"
          disabled={!document || page <= 1}
          onClick={() => move(page - 1)}
        >
          <ChevronLeft size={19} />
        </button>
        <label>
          <span className="sr-only">PDF 页码</span>
          <input
            aria-label="PDF 页码"
            type="number"
            min={1}
            max={document?.numPages || 1}
            value={page}
            onChange={(e) => move(Number(e.target.value) || 1)}
          />
        </label>
        <span>/ {document?.numPages ?? '…'}</span>
        <button
          className="icon-button"
          aria-label="下一页"
          disabled={!document || page >= document.numPages}
          onClick={() => move(page + 1)}
        >
          <ChevronRight size={19} />
        </button>
        <span className="toolbar-spacer" />
        <button
          className="icon-button"
          aria-label="缩小 PDF"
          onClick={() => setZoom((z) => Math.max(0.5, z - 0.2))}
        >
          <Minus size={17} />
        </button>
        <button
          className="icon-button"
          aria-label="放大 PDF"
          onClick={() => setZoom((z) => Math.min(3, z + 0.2))}
        >
          <Plus size={17} />
        </button>
        <a className="icon-button" href={fileUrl(fileId, true)} aria-label="下载 PDF">
          <Download size={17} />
        </a>
      </div>
      {error ? (
        <p className="inline-error">{error}</p>
      ) : !document ? (
        <Spinner label="正在打开 PDF…" />
      ) : (
        <div className="pdf-page" aria-busy={rendering}>
          <canvas ref={canvas} aria-label={`PDF 第 ${page} 页`} />
        </div>
      )}
    </div>
  );
}
