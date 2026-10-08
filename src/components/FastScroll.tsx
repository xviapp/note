import { useEffect, useRef, useState, type RefObject } from 'react';
import { useTheme } from '../theme';

// Phones only show a thin overlay scrollbar that cannot be dragged. Long
// documents get a handle on the right edge that appears while scrolling and
// jumps through the text when dragged.
const THUMB = 48;
const INSET = 8;
const HIDE_MS = 1500;
const LONG = 3; // screens of content before the handle is offered

const coarsePointer = () =>
  typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

export function FastScroll({
  target,
  onInteract,
}: {
  target: RefObject<HTMLElement | null>;
  onInteract?: () => void;
}) {
  const { ink } = useTheme();
  const handle = useRef<HTMLDivElement>(null);
  const [enabled] = useState(coarsePointer);
  const [visible, setVisible] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const dragging = useRef<{ offset: number; pointer: number } | null>(null);
  const callbacks = useRef({ onInteract });
  callbacks.current = { onInteract };

  useEffect(() => {
    const element = target.current;
    if (ink || !enabled || !element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let shown = false;
    const show = (value: boolean) => {
      if (shown === value) return;
      shown = value;
      setVisible(value);
      // Floating buttons near the edge step aside while the handle shows.
      if (value) document.documentElement.dataset.fastScroll = 'visible';
      else delete document.documentElement.dataset.fastScroll;
    };
    const place = () => {
      const max = element.scrollHeight - element.clientHeight;
      const long = element.scrollHeight > element.clientHeight * LONG;
      if (!long || max <= 0) return show(false);
      const track = element.clientHeight - INSET * 2 - THUMB;
      const top = INSET + (element.scrollTop / max) * track;
      const node = handle.current;
      if (node) {
        // Stay on the reading area's edge, left of a side table of contents.
        const parent = node.offsetParent?.getBoundingClientRect(),
          bounds = element.getBoundingClientRect();
        if (parent) node.style.right = `${parent.right - bounds.right}px`;
        node.style.transform = `translateY(${top + (parent ? bounds.top - parent.top : 0)}px)`;
      }
      return true;
    };
    const scrolled = () => {
      if (!place()) return;
      show(true);
      clearTimeout(timer);
      if (!dragging.current) timer = setTimeout(() => show(false), HIDE_MS);
    };
    element.addEventListener('scroll', scrolled, { passive: true });
    // Images and formulas change the document's height after it renders.
    const resize = new ResizeObserver(() => place());
    resize.observe(element);
    if (element.firstElementChild) resize.observe(element.firstElementChild);
    return () => {
      clearTimeout(timer);
      element.removeEventListener('scroll', scrolled);
      resize.disconnect();
      delete document.documentElement.dataset.fastScroll;
    };
  }, [enabled, target, ink]);

  if (ink)
    return (
      <nav className="ink-page-controls" aria-label="阅读翻屏">
        {([-1, 1] as const).map((direction) => (
          <button
            key={direction}
            className="button"
            onClick={() => {
              const element = target.current;
              if (!element) return;
              onInteract?.();
              element.scrollBy({
                top: direction * Math.max(1, element.clientHeight - 48),
                behavior: 'instant',
              });
            }}
          >
            {direction === -1 ? '上一屏' : '下一屏'}
          </button>
        ))}
      </nav>
    );
  if (!enabled) return null;
  const seek = (clientY: number) => {
    const element = target.current;
    const current = dragging.current;
    if (!element || !current) return;
    const bounds = element.getBoundingClientRect();
    const track = element.clientHeight - INSET * 2 - THUMB;
    const top = Math.min(track, Math.max(0, clientY - bounds.top - INSET - current.offset));
    const ratio = track > 0 ? top / track : 0;
    element.scrollTop = ratio * (element.scrollHeight - element.clientHeight);
    setDrag(Math.round(ratio * 100));
  };
  const finish = () => {
    if (!dragging.current) return;
    dragging.current = null;
    setDrag(null);
    // Let the usual scroll timeout hide the handle.
    target.current?.dispatchEvent(new Event('scroll'));
  };
  return (
    <div
      ref={handle}
      className={`fast-scroll${visible || drag !== null ? ' is-visible' : ''}${drag !== null ? ' is-dragging' : ''}`}
      role="scrollbar"
      aria-orientation="vertical"
      aria-label="快速滚动"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={drag ?? undefined}
      onPointerDown={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        dragging.current = { offset: event.clientY - bounds.top, pointer: event.pointerId };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
        callbacks.current.onInteract?.();
        seek(event.clientY);
      }}
      onPointerMove={(event) => {
        if (dragging.current?.pointer === event.pointerId) seek(event.clientY);
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
    >
      <span className="fast-scroll-thumb" />
      {drag !== null && <span className="fast-scroll-label">{drag}%</span>}
    </div>
  );
}
