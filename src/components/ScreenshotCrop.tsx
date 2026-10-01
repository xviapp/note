import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { cropScreenshot } from '../capture';
import { Modal } from './Primitives';

type Area = { x: number; y: number; width: number; height: number };
export function ScreenshotCrop({
  canvas,
  onDone,
  onClose,
}: {
  canvas: HTMLCanvasElement;
  onDone: (image: string) => void;
  onClose: () => void;
}) {
  const stage = useRef<HTMLDivElement>(null),
    start = useRef<{ x: number; y: number } | null>(null);
  const [area, setArea] = useState<Area | null>(null),
    [error, setError] = useState('');
  const [url] = useState(() => canvas.toDataURL('image/png'));
  useEffect(() => {
    let previous = '';
    const observer = new ResizeObserver(([entry]) => {
      const size = `${entry.contentRect.width}:${entry.contentRect.height}`;
      if (previous && previous !== size) setArea(null);
      previous = size;
    });
    observer.observe(stage.current!);
    return () => observer.disconnect();
  }, []);
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const rect = stage.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
    };
  };
  return (
    <Modal title="框选截图" wide className="capture-modal" onClose={onClose}>
      <div
        className="capture-stage"
        ref={stage}
        aria-label="拖动选择截图区域"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          stage.current!.setPointerCapture(e.pointerId);
          start.current = point(e);
          setArea(null);
        }}
        onPointerMove={(e) => {
          if (!start.current) return;
          const p = point(e),
            s = start.current;
          setArea({
            x: Math.min(p.x, s.x),
            y: Math.min(p.y, s.y),
            width: Math.abs(p.x - s.x),
            height: Math.abs(p.y - s.y),
          });
        }}
        onPointerUp={() => {
          start.current = null;
        }}
        onPointerCancel={() => {
          start.current = null;
        }}
      >
        <img src={url} alt="当前阅读区截图" draggable={false} />
        {area && (
          <div
            className="capture-box"
            style={{ left: area.x, top: area.y, width: area.width, height: area.height }}
          />
        )}
      </div>
      <p className="field-hint">拖动框选要提问的内容。</p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button
          className="button"
          onClick={() => {
            const rect = stage.current!.getBoundingClientRect();
            setArea({ x: 0, y: 0, width: rect.width, height: rect.height });
          }}
        >
          选择整个阅读区
        </button>
        <button
          className="button primary"
          disabled={!area || area.width < 8 || area.height < 8}
          onClick={() => {
            try {
              const rect = stage.current!.getBoundingClientRect();
              onDone(cropScreenshot(canvas, area!, rect.width, rect.height));
            } catch (e) {
              setError(e instanceof Error ? e.message : '截图失败，请重新框选。');
            }
          }}
        >
          采用截图
        </button>
      </div>
    </Modal>
  );
}
