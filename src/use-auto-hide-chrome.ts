import { useEffect, useState, type RefObject } from 'react';

const PHONE = '(max-width: 760px)';
// How far a finger must move one way before the toolbars follow.
const THRESHOLD = 24;

// On phones, scrolling down through a PDF slides the note and PDF toolbars away;
// scrolling back up a little, reaching the top or focusing a toolbar returns them.
// Only scrolls that follow a touch or wheel on the pages count, and PdfView marks
// its own jumps (a page number, a translation source, a zoom re-anchor).
// `owner` names the note being read, or is null when nothing should hide.
export function useAutoHideChrome(pane: RefObject<HTMLElement | null>, owner: string | null) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const element = pane.current;
    setHidden(false);
    if (!element || !owner) return;
    const phone = window.matchMedia(PHONE);
    let lastTop: number | null = null;
    let travel = 0;
    let lastInput = -Infinity;
    let pinchUntil = 0;
    let current = false;
    const set = (value: boolean) => {
      if (value === current) return;
      current = value;
      travel = 0;
      if (value) {
        const height = ['.note-toolbar', '.pdf-toolbar']
          .map((selector) => element.querySelector<HTMLElement>(selector)?.offsetHeight ?? 0)
          .reduce((sum, value) => sum + value, 0);
        element.style.setProperty('--chrome-height', `${height}px`);
      }
      setHidden(value);
    };
    const input = (event: Event) => {
      // Taps on the toolbars are not swipes, though their page jumps scroll.
      const area = (event.target as Element).closest('.note-workspace .pdf-scroll');
      if (!area) return;
      lastInput = performance.now();
      // The first scroll of a swipe needs a starting point to measure from.
      lastTop ??= area.scrollTop;
      if (event instanceof TouchEvent && event.touches.length > 1) pinchUntil = lastInput + 800;
    };
    // A pinch commits its zoom after the fingers lift; that scroll is not a swipe.
    const lifted = () => {
      if (pinchUntil > performance.now()) pinchUntil = performance.now() + 800;
    };
    const scrolled = (event: Event) => {
      const area = event.target as HTMLElement;
      // The page's own PDF, not one opened from an attachment dialog.
      if (!area.classList?.contains('pdf-scroll') || !area.closest('.note-workspace')) return;
      const top = area.scrollTop;
      const delta = lastTop === null ? 0 : top - lastTop;
      lastTop = top;
      if (!phone.matches) return set(false);
      if (top <= 0) return set(false);
      const now = performance.now();
      // A jump's mark covers only the scroll event that follows it.
      const programmed = Math.abs(top - Number(area.dataset.programmedTop)) < 1;
      delete area.dataset.programmedTop;
      if (programmed || now < pinchUntil || now - lastInput > 1500 || !delta) return;
      travel = Math.sign(delta) === Math.sign(travel) ? travel + delta : delta;
      if (travel > THRESHOLD && top > THRESHOLD) set(true);
      else if (travel < -THRESHOLD) set(false);
    };
    const focused = (event: FocusEvent) => {
      if ((event.target as Element).closest('.note-toolbar, .pdf-toolbar')) set(false);
    };
    const resized = () => {
      if (!phone.matches) set(false);
    };
    const passive = { passive: true, capture: true };
    element.addEventListener('scroll', scrolled, passive);
    element.addEventListener('touchstart', input, passive);
    element.addEventListener('touchmove', input, passive);
    element.addEventListener('touchend', lifted, passive);
    element.addEventListener('wheel', input, passive);
    element.addEventListener('focusin', focused);
    phone.addEventListener('change', resized);
    return () => {
      element.removeEventListener('scroll', scrolled, passive);
      element.removeEventListener('touchstart', input, passive);
      element.removeEventListener('touchmove', input, passive);
      element.removeEventListener('touchend', lifted, passive);
      element.removeEventListener('wheel', input, passive);
      element.removeEventListener('focusin', focused);
      phone.removeEventListener('change', resized);
    };
  }, [pane, owner]);
  return hidden && !!owner;
}
