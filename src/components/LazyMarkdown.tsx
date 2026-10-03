import { lazy, memo, Suspense, useEffect, useState, type ComponentProps } from 'react';
import type { MarkdownView as View } from './MarkdownView';

let loaded: typeof import('./MarkdownView') | null = null;
const load = () =>
  import('./MarkdownView').then((module) => {
    loaded = module;
    return module;
  });
const Markdown = lazy(() => load().then((module) => ({ default: module.MarkdownView })));

// Markdown parsing, KaTeX and sanitizing load on first use, keeping them out
// of the startup bundle. Once loaded, the renderer is used directly, since a
// lazy component suspends once more on its first render.
export const MarkdownView = memo(function LazyMarkdownView(props: ComponentProps<typeof View>) {
  if (loaded) return <loaded.MarkdownView {...props} />;
  return (
    <Suspense fallback={null}>
      <Markdown {...props} />
    </Suspense>
  );
});

// Fetch the renderer once the library is open, before a note needs it.
export const preloadMarkdown = () => void load().catch(() => {});

// Whether the renderer is ready. A note page waits for it so its body never
// appears empty while the toolbar (e.g. locating a translation) already works.
export function useMarkdownReady(needed: boolean): boolean {
  const [ready, setReady] = useState(() => !!loaded);
  useEffect(() => {
    if (!needed || ready) return;
    let live = true;
    void load()
      .then(() => {
        if (live) setReady(true);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [needed, ready]);
  return ready || !needed;
}
