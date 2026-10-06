import { useEffect, useRef, useState } from 'react';
import { TextLayer, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from 'pdfjs-dist';
import { Spinner } from './Primitives';
import type { PdfSourceRect } from '../../shared/translation';
import { useTheme } from '../theme';
import { currentPdfTint, tintPdfCanvas } from '../pdf-tint';

export function PdfPage({
  document,
  number,
  width,
  height,
  top,
  onMeasure,
  highlights,
  marks,
}: {
  document: PDFDocumentProxy;
  number: number;
  width: number;
  height: number;
  top: number;
  onMeasure: (number: number, aspect: number) => void;
  highlights?: PdfSourceRect[];
  // Saved highlights on this page; ones with a note are underlined.
  marks?: { id: string; noted: boolean; color: string; rects: PdfSourceRect[] }[];
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const textContainer = useRef<HTMLDivElement>(null);
  const active = useRef<RenderTask | null>(null);
  const [rendering, setRendering] = useState(true);
  const [error, setError] = useState('');
  const { theme } = useTheme();

  useEffect(() => {
    let live = true;
    let renderedPage: PDFPageProxy | undefined;
    let textLayer: TextLayer | undefined;
    const element = canvas.current!;
    const textElement = textContainer.current!;
    textElement.replaceChildren();
    const previous = active.current;
    previous?.cancel();
    setRendering(true);
    setError('');
    const work = (async () => {
      await previous?.promise.catch(() => {});
      if (!live) return;
      const page = await document.getPage(number);
      renderedPage = page;
      if (!live) return;
      const original = page.getViewport({ scale: 1 });
      onMeasure(number, original.height / original.width);
      const viewport = page.getViewport({ scale: width / original.width });
      // Bound each backing canvas, including very tall pages and high zoom on
      // retina phones. CSS keeps its full reading dimensions.
      const ratio = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(8_000_000 / (viewport.width * viewport.height)),
        8192 / Math.max(viewport.width, viewport.height),
      );
      element.width = Math.ceil(viewport.width * ratio);
      element.height = Math.ceil(viewport.height * ratio);
      const task = page.render({
        canvas: element,
        canvasContext: element.getContext('2d')!,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
        recordImages: true,
      });
      active.current = task;
      await task.promise;
      if (!live) return;
      const tint = currentPdfTint();
      if (tint) tintPdfCanvas(element, tint, page.imageCoordinates);
      setRendering(false);
      textElement.style.setProperty(
        '--total-scale-factor',
        String(viewport.scale * viewport.userUnit),
      );
      textLayer = new TextLayer({
        textContentSource: page.streamTextContent(),
        container: textElement,
        viewport,
      });
      // Some PDFs have no usable text. Their canvas remains readable/capturable.
      await textLayer.render().catch(() => {});
    })();
    void work.catch((e) => {
      if (live && e?.name !== 'RenderingCancelledException') {
        setError('这一页暂时无法显示，请重新打开或下载 PDF。');
        setRendering(false);
      }
    });
    return () => {
      live = false;
      active.current?.cancel();
      textLayer?.cancel();
      void work
        .catch(() => {})
        .then(() => {
          if (!element.isConnected) {
            element.width = 0;
            element.height = 0;
            renderedPage?.cleanup();
          }
        });
    };
    // The theme is read inside through its CSS tokens; a change repaints the page.
  }, [document, number, width, onMeasure, theme]);

  return (
    <div
      className="pdf-page"
      data-page={number}
      role="group"
      aria-label={`第 ${number} 页`}
      aria-busy={rendering}
      style={{ width, height, top }}
    >
      <canvas ref={canvas} aria-label={`PDF 第 ${number} 页`} />
      <div ref={textContainer} className="pdf-text-layer" />
      {marks?.flatMap((mark) =>
        mark.rects.map((rect, index) => (
          <div
            key={`${mark.id}-${index}`}
            className={`pdf-annotation color-${mark.color}${mark.noted ? ' has-note' : ''}`}
            aria-hidden="true"
            style={{
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.width * 100}%`,
              height: `${rect.height * 100}%`,
            }}
          />
        )),
      )}
      {highlights?.map((rect, index) => (
        <div
          key={index}
          className="pdf-source-highlight"
          aria-hidden="true"
          style={{
            left: `${rect.x * 100}%`,
            top: `${rect.y * 100}%`,
            width: `${rect.width * 100}%`,
            height: `${rect.height * 100}%`,
          }}
        />
      ))}
      {error ? (
        <p className="pdf-page-status inline-error" role="alert">
          {error}
        </p>
      ) : rendering ? (
        <div className="pdf-page-status">
          <Spinner label={`正在加载第 ${number} 页…`} />
        </div>
      ) : null}
    </div>
  );
}
