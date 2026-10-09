import { useEffect, useState } from 'react';

export interface VisualViewportBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function viewportBounds(): VisualViewportBounds {
  const viewport = window.visualViewport;
  return {
    x: viewport?.offsetLeft ?? 0,
    y: viewport?.offsetTop ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
  };
}

// The visual viewport follows mobile keyboards and browser zoom independently
// from the layout viewport, so floating panels need the same listener policy.
export function useVisualViewport(): VisualViewportBounds {
  const [viewport, setViewport] = useState(viewportBounds);
  useEffect(() => {
    const update = () => setViewport(viewportBounds());
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, []);
  return viewport;
}
