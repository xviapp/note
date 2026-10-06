import { useBookPageView, useBookView } from './book';
import { usePaperView } from './paper';
import { useProjectView } from './project';
import type { TypeContext, TypeView } from './view';

export { CREATABLE_TYPES, NOTE_TYPES, noteType, typeLabel } from './registry';
export type { AssistantCustom, TypeContext, TypeView } from './view';

// The note page's type-specific parts. Every type's hook runs on every render
// (hooks keep a fixed order); the one for this note's type returns its view.
export function useTypeView(
  ctx: TypeContext,
  extras: Parameters<typeof usePaperView>[1],
): TypeView {
  const views = [
    useBookView(ctx),
    useBookPageView(ctx),
    useProjectView(ctx),
    usePaperView(ctx, extras),
  ];
  return views.find(Boolean) ?? {};
}
