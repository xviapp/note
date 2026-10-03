import { lazy, memo, Suspense, type ComponentProps } from 'react';
import type { MarkdownView as View } from './MarkdownView';

const load = () => import('./MarkdownView');
const Markdown = lazy(() => load().then((module) => ({ default: module.MarkdownView })));

// Markdown parsing, KaTeX and sanitizing load on first use, keeping them out
// of the startup bundle. The note page re-restores reading position when the
// body grows, so the brief empty render needs no special handling.
export const MarkdownView = memo(function LazyMarkdownView(props: ComponentProps<typeof View>) {
  return (
    <Suspense fallback={null}>
      <Markdown {...props} />
    </Suspense>
  );
});

// Fetch the renderer once the library is open, before a note needs it.
export const preloadMarkdown = () => void load().catch(() => {});
