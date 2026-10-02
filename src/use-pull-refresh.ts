import { useEffect, useRef, useState, type RefObject } from 'react';

export function usePullRefresh(
  scroll: RefObject<HTMLDivElement | null>,
  key: string,
  enabled: boolean,
  refresh: () => Promise<void>,
  onError: (error: unknown) => void,
) {
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const busy = useRef(false);
  const callbacks = useRef({ refresh, onError });
  callbacks.current = { refresh, onError };
  useEffect(() => {
    const element = scroll.current;
    if (!element || !enabled) return;
    let start: { x: number; y: number } | null = null;
    let pull = 0;
    let live = true;
    const reset = () => {
      start = null;
      pull = 0;
      setDistance(0);
    };
    const begin = (event: TouchEvent) => {
      reset();
      if (busy.current || element.scrollTop > 0 || event.touches.length !== 1) return;
      if (
        (event.target as Element).closest('input, textarea, select, [contenteditable], .menu-popup')
      )
        return;
      start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    };
    const move = (event: TouchEvent) => {
      if (!start) return;
      // A long press that picked up a tree row is a move, not a pull.
      if (document.documentElement.dataset.treeDrag) return reset();
      if (event.touches.length !== 1 || element.scrollTop > 0) return reset();
      const dy = event.touches[0].clientY - start.y;
      const dx = Math.abs(event.touches[0].clientX - start.x);
      if (dy <= 0 || dx > dy) return reset();
      if (event.cancelable) event.preventDefault();
      pull = Math.min(90, dy * 0.5);
      setDistance(pull);
    };
    const finish = () => {
      const trigger = pull >= 64;
      reset();
      if (!trigger || busy.current) return;
      busy.current = true;
      setRefreshing(true);
      void callbacks.current
        .refresh()
        .catch(callbacks.current.onError)
        .finally(() => {
          busy.current = false;
          if (live) setRefreshing(false);
        });
    };
    element.addEventListener('touchstart', begin, { passive: true });
    element.addEventListener('touchmove', move, { passive: false });
    element.addEventListener('touchend', finish);
    element.addEventListener('touchcancel', reset);
    return () => {
      live = false;
      reset();
      setRefreshing(false);
      element.removeEventListener('touchstart', begin);
      element.removeEventListener('touchmove', move);
      element.removeEventListener('touchend', finish);
      element.removeEventListener('touchcancel', reset);
    };
  }, [scroll, key, enabled]);
  return { distance, refreshing };
}
