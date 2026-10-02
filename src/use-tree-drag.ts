import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type TouchEvent as ReactTouchEvent,
} from 'react';
import type { NoteNode } from '../shared/types';
import { Capacitor } from '@capacitor/core';

// Moves notes by pointer instead of HTML drag-and-drop. Android WebView does not
// start native drags from touch, and the browser's drag image cannot be styled.
//
// Rows carry data-tree-node (id) and data-tree-container (accepts children);
// each <li> carries data-tree-item so a folder's subtree can be excluded. The
// element marked data-tree-root receives moves to the top level.
export const ROOT_TARGET = '';
const MOUSE_SLOP = 5;
const TOUCH_SLOP = 8;
const LONG_PRESS_MS = 350;
const EXPAND_MS = 600;
const EDGE = 56;

export type TreeDrag = {
  source: NoteNode;
  pointer: 'mouse' | 'touch';
  // A row id, ROOT_TARGET for the top level, or undefined when not droppable.
  target: string | undefined;
  // Where the drag started, for the ghost's first frame.
  x: number;
  y: number;
};
// Keep the card clear of the finger; beside the cursor on desktop.
export const ghostTransform = (x: number, y: number, pointer: 'mouse' | 'touch') =>
  pointer === 'touch'
    ? `translate3d(${x - 28}px, ${y - 64}px, 0)`
    : `translate3d(${x + 14}px, ${y + 10}px, 0)`;
type Pending = {
  node: NoteNode;
  x: number;
  y: number;
  pointer: 'mouse' | 'touch';
  capture?: () => void;
};

// A short confirmation tap when a long press picks up a note.
function haptic() {
  if (Capacitor.getPlatform() === 'android')
    void import('./mobile').then(({ device }) => device.haptic()).catch(() => {});
  else
    try {
      navigator.vibrate?.(10);
    } catch {
      /* Optional feedback. */
    }
}
function scrollParent(element: HTMLElement | null) {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (/(auto|scroll)/.test(overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

export function useTreeDrag(
  root: RefObject<HTMLElement | null>,
  ghost: RefObject<HTMLElement | null>,
  {
    onDrop,
    onExpand,
  }: {
    onDrop: (source: NoteNode, target: string) => void;
    onExpand: (id: string) => void;
  },
) {
  const [drag, setDrag] = useState<TreeDrag | null>(null);
  const callbacks = useRef({ onDrop, onExpand });
  callbacks.current = { onDrop, onExpand };
  const session = useRef<{
    pending: Pending;
    active: boolean;
    x: number;
    y: number;
    target: string | undefined;
    timer?: ReturnType<typeof setTimeout>;
    expand?: { id: string; timer: ReturnType<typeof setTimeout> };
    frame?: number;
    cleanup: (() => void)[];
  } | null>(null);

  const place = (x: number, y: number, pointer: 'mouse' | 'touch') => {
    if (ghost.current) ghost.current.style.transform = ghostTransform(x, y, pointer);
  };

  const targetAt = (x: number, y: number, source: NoteNode): string | undefined => {
    const element = document.elementFromPoint(x, y);
    if (!element || !root.current?.contains(element)) return undefined;
    if (element.closest('[data-tree-root]'))
      return source.parent_id === null ? undefined : ROOT_TARGET;
    const row = element.closest<HTMLElement>('[data-tree-node]');
    const id = row?.dataset.treeNode;
    if (!row || !id || row.dataset.treeContainer !== 'true' || id === source.parent_id)
      return undefined;
    // A folder cannot move into itself or anything beneath it.
    if (row.closest(`[data-tree-item="${CSS.escape(source.id)}"]`)) return undefined;
    return id;
  };

  const end = useCallback((commit: boolean) => {
    const current = session.current;
    if (!current) return;
    session.current = null;
    clearTimeout(current.timer);
    if (current.expand) clearTimeout(current.expand.timer);
    if (current.frame) cancelAnimationFrame(current.frame);
    for (const cleanup of current.cleanup) cleanup();
    delete document.documentElement.dataset.treeDrag;
    setDrag(null);
    if (commit && current.active && current.target !== undefined)
      callbacks.current.onDrop(current.pending.node, current.target);
  }, []);

  const retarget = () => {
    const current = session.current;
    if (!current?.active) return;
    const target = targetAt(current.x, current.y, current.pending.node);
    // Over a row or the root zone that cannot take this note: show a no-drop cursor.
    const over = document
      .elementFromPoint(current.x, current.y)
      ?.closest('[data-tree-node], [data-tree-root]');
    document.documentElement.dataset.treeDrag =
      over && root.current?.contains(over) && target === undefined ? 'blocked' : 'active';
    if (target !== current.target) {
      current.target = target;
      setDrag((value) => (value ? { ...value, target } : value));
    }
    // Hovering a collapsed folder opens it, so deeper folders can be reached.
    const row = target
      ? root.current?.querySelector<HTMLElement>(`[data-tree-item="${CSS.escape(target)}"]`)
      : null;
    const collapsed = row?.getAttribute('aria-expanded') === 'false';
    if (current.expand && current.expand.id !== target) {
      clearTimeout(current.expand.timer);
      current.expand = undefined;
    }
    if (collapsed && target && !current.expand)
      current.expand = {
        id: target,
        timer: setTimeout(() => {
          if (session.current?.target === target) callbacks.current.onExpand(target);
        }, EXPAND_MS),
      };
  };

  const scrollLoop = (container: HTMLElement | null) => {
    const step = () => {
      const current = session.current;
      if (!current?.active) return;
      if (container) {
        const rect = container.getBoundingClientRect();
        const top = current.y - rect.top,
          bottom = rect.bottom - current.y;
        const speed =
          top < EDGE
            ? -(1 - Math.max(0, top) / EDGE)
            : bottom < EDGE
              ? 1 - Math.max(0, bottom) / EDGE
              : 0;
        if (speed) {
          const before = container.scrollTop;
          container.scrollTop += speed * 14;
          if (container.scrollTop !== before) retarget();
        }
      }
      current.frame = requestAnimationFrame(step);
    };
    session.current!.frame = requestAnimationFrame(step);
  };

  const activate = () => {
    const current = session.current;
    if (!current || current.active) return;
    current.active = true;
    document.documentElement.dataset.treeDrag = 'active';
    window.getSelection()?.removeAllRanges();
    if (current.pending.pointer === 'touch') haptic();
    // Captured only once dragging, so a plain click still reaches the row's button.
    current.pending.capture?.();
    setDrag({
      source: current.pending.node,
      pointer: current.pending.pointer,
      target: undefined,
      x: current.x,
      y: current.y,
    });
    scrollLoop(scrollParent(root.current));
  };

  const move = (x: number, y: number) => {
    const current = session.current;
    if (!current) return;
    current.x = x;
    current.y = y;
    if (!current.active) return;
    place(x, y, current.pending.pointer);
    retarget();
  };

  const listen = <K extends keyof WindowEventMap>(
    type: K,
    handler: (event: WindowEventMap[K]) => void,
    options: AddEventListenerOptions = {},
  ) => {
    window.addEventListener(type, handler, options);
    session.current?.cleanup.push(() => window.removeEventListener(type, handler, options));
  };

  const begin = (pending: Pending) => {
    end(false);
    session.current = {
      pending,
      active: false,
      x: pending.x,
      y: pending.y,
      target: undefined,
      cleanup: [],
    };
    listen(
      'keydown',
      (event) => {
        if (event.key === 'Escape' && session.current?.active) {
          event.preventDefault();
          event.stopPropagation();
          end(false);
        }
      },
      { capture: true },
    );
    listen('blur', () => end(false));
  };

  const startMouse = (event: ReactPointerEvent, node: NoteNode) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    if ((event.target as Element).closest('.node-menu')) return;
    const element = event.currentTarget,
      pointerId = event.pointerId;
    begin({
      node,
      x: event.clientX,
      y: event.clientY,
      pointer: 'mouse',
      capture: () => {
        try {
          element.setPointerCapture(pointerId);
        } catch {
          /* The pointer may already be released. */
        }
      },
    });
    listen('pointermove', (move_) => {
      const current = session.current;
      if (!current) return;
      if (
        !current.active &&
        Math.hypot(move_.clientX - current.pending.x, move_.clientY - current.pending.y) >
          MOUSE_SLOP
      )
        activate();
      move(move_.clientX, move_.clientY);
    });
    listen('pointerup', () => {
      // A completed drag must not also open the row under the pointer. The
      // click, if any, follows this pointerup before the next task runs.
      if (session.current?.active) {
        const swallow = (click: MouseEvent) => {
          click.preventDefault();
          click.stopPropagation();
        };
        window.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      }
      end(true);
    });
    listen('pointercancel', () => end(false));
  };

  const startTouch = (event: ReactTouchEvent, node: NoteNode) => {
    if (event.touches.length !== 1) return end(false);
    if ((event.target as Element).closest('.node-menu')) return;
    const touch = event.touches[0];
    begin({ node, x: touch.clientX, y: touch.clientY, pointer: 'touch' });
    session.current!.timer = setTimeout(activate, LONG_PRESS_MS);
    listen(
      'touchmove',
      (move_) => {
        const current = session.current;
        if (!current) return;
        const point = move_.touches[0];
        if (!current.active) {
          // Moving before the long press completes is an ordinary scroll.
          if (
            move_.touches.length !== 1 ||
            Math.hypot(point.clientX - current.pending.x, point.clientY - current.pending.y) >
              TOUCH_SLOP
          )
            end(false);
          return;
        }
        if (move_.cancelable) move_.preventDefault();
        move(point.clientX, point.clientY);
      },
      { capture: true, passive: false },
    );
    listen(
      'touchend',
      (finish) => {
        if (session.current?.active && finish.cancelable) finish.preventDefault();
        end(true);
      },
      { capture: true, passive: false },
    );
    listen('touchcancel', () => end(false), { capture: true });
    listen(
      'contextmenu',
      (menu) => {
        menu.preventDefault();
      },
      { capture: true },
    );
  };

  useEffect(() => () => end(false), [end]);
  return { drag, startMouse, startTouch, cancel: () => end(false) };
}
