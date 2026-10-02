import { useEffect, useRef, type RefObject } from 'react';
export const boundZoom = (value: number) => Math.min(3, Math.max(0.5, value));
export function savedPdfZoom(fileId: string) {
  try {
    const value = Number(localStorage.getItem(`pdf-view:${fileId}`));
    return Number.isFinite(value) && value >= 0.5 && value <= 3 ? value : 1;
  } catch {
    return 1;
  }
}
export type ZoomPoint = { x: number; y: number };

// Preview using the existing canvases; render PDF pages once after the fingers
// lift. Single-finger scrolling and long-press text selection stay with WebView.
export function usePdfGestures(
  scroll: RefObject<HTMLDivElement | null>,
  zoom: number,
  commit: (zoom: number, point?: ZoomPoint, target?: ZoomPoint) => void,
) {
  const latest = useRef({ zoom, commit });
  latest.current = { zoom, commit };
  useEffect(() => {
    const area = scroll.current;
    if (!area) return;
    let pinch: {
      distance: number;
      zoom: number;
      ratio: number;
      start: ZoomPoint;
      point: ZoomPoint;
      pages: HTMLElement;
    } | null = null;
    let tap: { x: number; y: number; time: number } | null = null;
    let lastTap: { x: number; y: number; time: number } | null = null;
    let suppress = false;
    const measure = (touches: TouchList) => {
      const a = touches[0],
        b = touches[1],
        rect = area.getBoundingClientRect();
      return {
        distance: Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)),
        point: {
          x: (a.clientX + b.clientX) / 2 - rect.left,
          y: (a.clientY + b.clientY) / 2 - rect.top,
        },
      };
    };
    const reset = () => {
      if (pinch) {
        pinch.pages.style.transform = '';
        pinch.pages.style.transformOrigin = '';
        pinch.pages.style.willChange = '';
      }
      delete area.dataset.pinching;
    };
    const start = (event: TouchEvent) => {
      if (event.touches.length === 1 && !suppress) {
        tap = { x: event.touches[0].clientX, y: event.touches[0].clientY, time: Date.now() };
      }
      if (event.touches.length !== 2 || pinch) return;
      const pages = area.querySelector<HTMLElement>('.pdf-pages');
      if (!pages || !event.cancelable) return;
      event.preventDefault();
      tap = null;
      lastTap = null;
      suppress = true;
      window.getSelection()?.removeAllRanges();
      const { distance, point } = measure(event.touches);
      pinch = { distance, zoom: latest.current.zoom, ratio: 1, start: point, point, pages };
      pages.style.transformOrigin = `${area.scrollLeft + point.x}px ${area.scrollTop + point.y}px`;
      pages.style.willChange = 'transform';
      area.dataset.pinching = 'true';
    };
    const move = (event: TouchEvent) => {
      if (
        tap &&
        Math.hypot(event.touches[0].clientX - tap.x, event.touches[0].clientY - tap.y) > 12
      )
        tap = null;
      if (!pinch) return;
      if (event.cancelable) event.preventDefault();
      if (event.touches.length !== 2) return;
      const { distance, point } = measure(event.touches);
      pinch.ratio = boundZoom((pinch.zoom * distance) / pinch.distance) / pinch.zoom;
      pinch.point = point;
      pinch.pages.style.transform = `translate(${point.x - pinch.start.x}px,${point.y - pinch.start.y}px) scale(${pinch.ratio})`;
    };
    const end = (event: TouchEvent) => {
      if (pinch && event.touches.length < 2) {
        const next = pinch;
        reset();
        pinch = null;
        if (event.type !== 'touchcancel')
          latest.current.commit(boundZoom(next.zoom * next.ratio), next.start, next.point);
      } else if (tap && !suppress && !event.touches.length && event.type !== 'touchcancel') {
        const now = Date.now();
        if (
          now - tap.time < 250 &&
          lastTap &&
          now - lastTap.time < 320 &&
          Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < 24 &&
          window.getSelection()?.isCollapsed !== false
        ) {
          if (event.cancelable) event.preventDefault();
          latest.current.commit(1);
          lastTap = null;
        } else lastTap = now - tap.time < 250 ? { ...tap, time: now } : null;
      }
      tap = null;
      if (!event.touches.length) suppress = false;
    };
    area.addEventListener('touchstart', start, { passive: false });
    area.addEventListener('touchmove', move, { passive: false });
    area.addEventListener('touchend', end, { passive: false });
    area.addEventListener('touchcancel', end);
    return () => {
      reset();
      area.removeEventListener('touchstart', start);
      area.removeEventListener('touchmove', move);
      area.removeEventListener('touchend', end);
      area.removeEventListener('touchcancel', end);
    };
  }, [scroll]);
}
