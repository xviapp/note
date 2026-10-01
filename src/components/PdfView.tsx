import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { openPdf } from '../pdf-document';
import { ChevronLeft, ChevronRight, Minus, Plus, Download } from 'lucide-react';
import { fileUrl } from '../api';
import type { ReadingPosition } from '../../shared/types';
import { Spinner } from './Primitives';
import { PdfPage } from './PdfPage';

type Position = { page: number; pageRatio: number };
type PageBox = { top: number; height: number };

// Page offsets include unloaded placeholders, so jumps do not need to render
// every preceding page. Unknown page sizes use the first page's aspect ratio.
function pageAt(boxes: PageBox[], top: number) {
  let low = 0;
  let high = boxes.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (boxes[middle].top <= top) low = middle;
    else high = middle - 1;
  }
  return low;
}

export default function PdfView({
  fileId,
  initialPosition = {},
  onPosition,
}: {
  fileId: string;
  initialPosition?: ReadingPosition;
  onPosition?: (position: Position) => void;
}) {
  const [document, setDocument] = useState<{
    pdf: PDFDocumentProxy;
    aspect: number;
  } | null>(null);
  const [page, setPage] = useState(initialPosition.page || 1);
  const [pageInput, setPageInput] = useState(String(page));
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState('');
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [aspects, setAspects] = useState<Map<number, number>>(new Map());
  const [scrollTop, setScrollTop] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const position = useRef<Position>({
    page: initialPosition.page || 1,
    pageRatio: initialPosition.pageRatio || 0,
  });
  const initial = useRef(initialPosition);
  const programmedScroll = useRef<number | null>(null);
  const onPositionRef = useRef(onPosition);
  onPositionRef.current = onPosition;

  useEffect(() => {
    let live = true;
    setError('');
    setDocument(null);
    setAspects(new Map());
    position.current = {
      page: initial.current.page || 1,
      pageRatio: initial.current.pageRatio || 0,
    };
    const task = openPdf(fileUrl(fileId));
    void task.promise
      .then(async (pdf) => {
        const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
        if (live) {
          position.current.page = Math.min(pdf.numPages, Math.max(1, position.current.page));
          setDocument({ pdf, aspect: first.height / first.width });
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
      void task.destroy().catch(() => {});
    };
  }, [fileId]);

  useEffect(() => {
    const element = scroll.current!;
    const observer = new ResizeObserver(() =>
      setViewport({ width: element.clientWidth, height: element.clientHeight }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const gap = viewport.width <= 600 ? 12 : 24;
  const width = Math.max(1, viewport.width - 2 * gap) * zoom;
  const layout = useMemo(() => {
    if (!document || !viewport.width || !viewport.height) return null;
    let top = gap;
    const boxes = Array.from({ length: document.pdf.numPages }, (_, index) => {
      const height = width * (aspects.get(index + 1) ?? document.aspect);
      const box = { top, height };
      top += height + gap;
      return box;
    });
    // Leave room to align the last page at the top even when it is landscape.
    const height = Math.max(top, boxes.at(-1)!.top - gap + viewport.height);
    return { boxes, height };
  }, [document, aspects, width, gap, viewport.width, viewport.height]);

  const syncPage = (value: number) => {
    setPage(value);
    setPageInput(String(value));
  };

  // Preserve the page and the point within it when zoom, screen size, or a
  // newly measured mixed-size page changes the offsets above the viewport.
  useLayoutEffect(() => {
    if (!layout || !scroll.current) return;
    const anchor = position.current;
    const box = layout.boxes[anchor.page - 1];
    scroll.current.scrollTop = box.top - gap + anchor.pageRatio * box.height;
    programmedScroll.current = scroll.current.scrollTop;
    setScrollTop(scroll.current.scrollTop);
    syncPage(anchor.page);
  }, [layout, gap]);

  const measure = useCallback((number: number, aspect: number) => {
    setAspects((previous) => {
      if (previous.get(number) === aspect) return previous;
      return new Map(previous).set(number, aspect);
    });
  }, []);

  const recordScroll = () => {
    const area = scroll.current;
    if (!layout || !area) return;
    setScrollTop(area.scrollTop);
    if (
      programmedScroll.current !== null &&
      Math.abs(area.scrollTop - programmedScroll.current) < 1
    )
      return;
    programmedScroll.current = null;
    const index = pageAt(layout.boxes, area.scrollTop + gap);
    const box = layout.boxes[index];
    const next = {
      page: index + 1,
      pageRatio: Math.max(0, Math.min(1, (area.scrollTop + gap - box.top) / box.height)),
    };
    if (
      next.page !== position.current.page ||
      Math.abs(next.pageRatio - position.current.pageRatio) > 0.0001
    ) {
      position.current = next;
      syncPage(next.page);
      onPositionRef.current?.(next);
    }
  };

  const move = (value: number) => {
    if (!document || !layout || !scroll.current) return;
    const next = Math.max(1, Math.min(document.pdf.numPages, Math.trunc(value) || 1));
    position.current = { page: next, pageRatio: 0 };
    scroll.current.scrollTop = layout.boxes[next - 1].top - gap;
    programmedScroll.current = scroll.current.scrollTop;
    setScrollTop(scroll.current.scrollTop);
    syncPage(next);
    onPositionRef.current?.(position.current);
  };

  const commitPage = () => {
    if (Number(pageInput) !== page) move(Number(pageInput));
    else setPageInput(String(page));
  };
  // Only keep the visible pages and one viewport on either side in memory.
  const start = layout ? pageAt(layout.boxes, Math.max(0, scrollTop - viewport.height)) : 0;
  const end = layout ? pageAt(layout.boxes, scrollTop + 2 * viewport.height) : 0;

  return (
    <div className="pdf-view" role="region" aria-label="PDF 阅读器">
      <div className="pdf-toolbar" role="toolbar" aria-label="PDF 阅读工具">
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
            max={document?.pdf.numPages || 1}
            disabled={!layout}
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            onBlur={commitPage}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commitPage();
                scroll.current?.focus({ preventScroll: true });
              }
            }}
          />
        </label>
        <span className="pdf-page-count">/ {document?.pdf.numPages ?? '…'}</span>
        <button
          className="icon-button"
          aria-label="下一页"
          disabled={!document || page >= document.pdf.numPages}
          onClick={() => move(page + 1)}
        >
          <ChevronRight size={19} />
        </button>
        <span className="toolbar-spacer" />
        <button
          className="icon-button"
          aria-label="缩小 PDF"
          disabled={!layout || zoom <= 0.5}
          onClick={() => setZoom((value) => Math.max(0.5, +(value - 0.2).toFixed(1)))}
        >
          <Minus size={17} />
        </button>
        <button
          className="pdf-fit-button"
          aria-label="PDF 适应宽度"
          title="适应宽度"
          disabled={!layout}
          onClick={() => setZoom(1)}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          className="icon-button"
          aria-label="放大 PDF"
          disabled={!layout || zoom >= 3}
          onClick={() => setZoom((value) => Math.min(3, +(value + 0.2).toFixed(1)))}
        >
          <Plus size={17} />
        </button>
        <a className="icon-button" href={fileUrl(fileId, true)} aria-label="下载 PDF">
          <Download size={17} />
        </a>
      </div>
      <div
        className="pdf-scroll"
        ref={scroll}
        tabIndex={0}
        aria-label="PDF 阅读区"
        onScroll={recordScroll}
      >
        {error ? (
          <p className="inline-error" role="alert">
            {error}
          </p>
        ) : !document || !layout ? (
          <Spinner label="正在打开 PDF…" />
        ) : (
          <div
            className="pdf-pages"
            style={{ height: layout.height, width: Math.max(viewport.width, width + gap * 2) }}
          >
            {layout.boxes.slice(start, end + 1).map((box, offset) => (
              <PdfPage
                key={start + offset + 1}
                document={document.pdf}
                number={start + offset + 1}
                width={width}
                height={box.height}
                top={box.top}
                onMeasure={measure}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
