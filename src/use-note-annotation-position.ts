import { useEffect, useMemo } from 'react';
import type { NoteDetail } from '../shared/types';
import type { Annotation } from '../shared/annotations';
import type { SourceLocation } from '../shared/translation';
import { takeRequestedAnnotation } from './annotations';

export function useNoteAnnotationPosition({
  id, note, annotationList, missingText, locateSource, onNotice,
}: {
  id: string;
  note: NoteDetail | null;
  annotationList: Annotation[];
  missingText: Set<string>;
  locateSource: (location: SourceLocation) => string | undefined;
  onNotice?: (message: string) => void;
}) {
  // Text that changed is found while painting; a PDF only goes missing with its file.
  const missingAnnotations = useMemo(() => {
    const files = new Set([note?.file?.id, ...(note?.attachments ?? []).map((file) => file.id)]);
    return new Set([
      ...missingText,
      ...annotationList
        .filter((item) => item.location.kind === 'pdf' && !files.has(item.location.fileId))
        .map((item) => item.id),
    ]);
  }, [missingText, annotationList, note?.file, note?.attachments]);
  const locateAnnotation = (item: Annotation) => locateSource(item.location);
  // A search result in a note: once the list and text are there, go to it.
  useEffect(() => {
    if (!annotationList.length) return;
    const wanted = takeRequestedAnnotation(id);
    const item = wanted && annotationList.find((annotation) => annotation.id === wanted);
    if (!item) return;
    let tries = 0,
      timer = 0;
    const attempt = () => {
      const failed = locateAnnotation(item);
      if (failed && ++tries < 20) timer = window.setTimeout(attempt, 150);
      else if (failed) onNotice?.(failed);
    };
    timer = window.setTimeout(attempt, 100);
    return () => window.clearTimeout(timer);
    // Runs when a file's list arrives; locateAnnotation reads the latest note.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [annotationList, id]);
  return { missingAnnotations, locateAnnotation };
}
