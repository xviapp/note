import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

type Point = { x: number; y: number };

// Window layout owns the bounds; the handle owns pointer capture and keyboard
// movement. This leaves sheet gestures and docking with their window.
export function useWindowDrag({ enabled, point, clamp, onMove, stopKeyPropagation = false }: {
  enabled: boolean;
  point: Point;
  clamp: (x: number, y: number) => Point;
  onMove: (point: Point) => void;
  stopKeyPropagation?: boolean;
}) {
  const drag = useRef<(Point & { id: number; startX: number; startY: number }) | null>(null);
  const [dragging, setDragging] = useState(false);
  const end = () => {
    drag.current = null;
    setDragging(false);
  };
  return {
    dragging,
    handleProps: {
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        if (!enabled || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, ...point };
        setDragging(true);
      },
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        const start = drag.current;
        if (start?.id === event.pointerId)
          onMove(clamp(start.x + event.clientX - start.startX, start.y + event.clientY - start.startY));
      },
      onPointerUp: end,
      onPointerCancel: end,
      onLostPointerCapture: end,
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        if (!enabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        if (stopKeyPropagation) event.stopPropagation();
        const step = event.shiftKey ? 40 : 10;
        onMove(clamp(
          point.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
          point.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0),
        ));
      },
    },
  };
}
