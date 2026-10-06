import { lazy, Suspense, useState } from 'react';
import { variantOf } from '../../shared/types';
import { usePaperSession } from '../use-paper-session';
import type { useAnnotations } from '../annotations';
import type { TypeContext, TypeView } from './view';

const CompareView = lazy(() => import('../components/CompareView'));

// An imported arXiv paper: whole-paper translation and side-by-side reading.
// The translation session belongs to the page, so it keeps running after the
// comparison view is closed.
export function usePaperView(
  ctx: TypeContext,
  {
    quote,
    annotations,
    realOffline,
  }: {
    quote: (text: string) => string | undefined;
    annotations: ReturnType<typeof useAnnotations>;
    realOffline: boolean;
  },
): TypeView | null {
  const paper = !!ctx.note && variantOf(ctx.note) === 'paper';
  const [open, setOpen] = useState(false);
  const session = usePaperSession(paper ? ctx.note : null, {
    onFinished: (message) => ctx.onNotice?.(message),
    onExported: () => {
      ctx.onChanged();
      ctx.refresh();
    },
  });
  if (!paper || !ctx.note) return null;
  return {
    fullscreen: open,
    compare: {
      open: () => setOpen(true),
      progress:
        session.running && session.total
          ? `${Math.floor((session.done / session.total) * 100)}%`
          : undefined,
    },
    dialogs: open && (
      <Suspense fallback={null}>
        <CompareView
          note={ctx.note}
          session={session}
          onClose={() => setOpen(false)}
          onChanged={ctx.onChanged}
          onQuote={quote}
          annotations={annotations}
          offline={realOffline}
        />
      </Suspense>
    ),
  };
}
