import { useRef, useState } from 'react';
import { Minus, Plus, RotateCcw, Download } from 'lucide-react';
import { Modal } from './Primitives';
export default function ImageViewer({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1),
    [offset, setOffset] = useState({ x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>()),
    last = useRef<{ distance: number; scale: number } | null>(null);
  const clamp = (value: number) => Math.max(0.5, Math.min(5, value));
  return (
    <Modal title={alt || '查看图片'} onClose={onClose} wide className="image-modal">
      <div className="image-toolbar">
        <button
          className="icon-button"
          aria-label="缩小图片"
          onClick={() => setScale((s) => clamp(s - 0.25))}
        >
          <Minus size={18} />
        </button>
        <span>{Math.round(scale * 100)}%</span>
        <button
          className="icon-button"
          aria-label="放大图片"
          onClick={() => setScale((s) => clamp(s + 0.25))}
        >
          <Plus size={18} />
        </button>
        <button
          className="icon-button"
          aria-label="适应窗口"
          onClick={() => {
            setScale(1);
            setOffset({ x: 0, y: 0 });
          }}
        >
          <RotateCcw size={18} />
        </button>
        <a
          className="icon-button"
          href={
            /^(data:|blob:)/.test(src) ? src : `${src}${src.includes('?') ? '&' : '?'}download=1`
          }
          download={/^(data:|blob:)/.test(src) ? 'screenshot.jpg' : undefined}
          target="_blank"
          rel="noreferrer"
          aria-label="下载图片"
        >
          <Download size={18} />
        </a>
      </div>
      <div
        className="image-stage"
        onWheel={(event) => setScale((s) => clamp(s - event.deltaY * 0.002))}
        onDoubleClick={() => {
          setScale((s) => (s === 1 ? 2 : 1));
          setOffset({ x: 0, y: 0 });
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          if (pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()];
            last.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale };
          }
        }}
        onPointerMove={(event) => {
          const old = pointers.current.get(event.pointerId);
          if (!old) return;
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          if (pointers.current.size === 2 && last.current) {
            const [a, b] = [...pointers.current.values()];
            setScale(
              clamp(
                (last.current.scale * Math.hypot(a.x - b.x, a.y - b.y)) / last.current.distance,
              ),
            );
          } else if (scale > 1)
            setOffset((o) => ({ x: o.x + event.clientX - old.x, y: o.y + event.clientY - old.y }));
        }}
        onPointerUp={(event) => {
          pointers.current.delete(event.pointerId);
          last.current = null;
        }}
        onPointerCancel={(event) => {
          pointers.current.delete(event.pointerId);
          last.current = null;
        }}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          style={{ transform: `translate(${offset.x}px,${offset.y}px) scale(${scale})` }}
        />
      </div>
    </Modal>
  );
}
