import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { TEXT_KINDS, type NoteDetail, type ReadingPosition } from '../shared/types';
import { useReading } from './useReading';
import { useNoteToc } from './use-note-toc';
import { useReadingPreferences } from './reading-preferences';

function restoreTextPosition(area: HTMLElement, position: ReadingPosition) {
  const anchors = Array.from(
    area.querySelectorAll<HTMLElement>(
      '.read-content [id^="heading-"], .read-content [data-paper-heading]',
    ),
  );
  const index = anchors.findIndex((element) => element.id === position.heading),
    anchor = anchors[index];
  if (anchor) {
    const nextTop =
      anchors[index + 1]?.getBoundingClientRect().top ??
      area.querySelector('.read-content')!.getBoundingClientRect().bottom;
    const sectionHeight = Math.max(1, nextTop - anchor.getBoundingClientRect().top);
    area.scrollTop +=
      anchor.getBoundingClientRect().top -
      area.getBoundingClientRect().top -
      24 +
      (position.headingRatio || 0) * sectionHeight;
  } else area.scrollTop = (area.scrollHeight - area.clientHeight) * (position.ratio || 0);
}

export function useNoteReading({
  id, note, editing,
}: {
  id: string;
  note: NoteDetail | null;
  editing: boolean;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const readingPreferences = useReadingPreferences();
  const tocPosition = useRef<ReadingPosition | null>(null);
  const revealAppend = useRef(false);
  useLayoutEffect(() => {
    if (!revealAppend.current || !note) return;
    revealAppend.current = false;
    touched.current = restored.current = true;
    requestAnimationFrame(() => {
      const area = scroll.current;
      if (area) area.scrollTop = area.scrollHeight;
    });
  }, [note]);
  const toc = useNoteToc({
    scroll,
    beforeSideToggle: () => {
      touched.current = restored.current = true;
      tocPosition.current = recordScroll() ?? null;
    },
    onJump: () => {
      touched.current = restored.current = true;
    },
  });
  const reading = useReading(id),
    restored = useRef(false),
    touched = useRef(false);
  const noteId = note?.id;
  const restorePosition = useCallback(() => {
    if (!noteId || !reading.initial || editing || touched.current || !scroll.current) return;
    restoreTextPosition(scroll.current, reading.initial);
    restored.current = true;
  }, [noteId, reading.initial, editing]);
  useEffect(() => {
    const timer = window.setTimeout(restorePosition, 120);
    return () => clearTimeout(timer);
  }, [restorePosition, toc.headings]);
  useEffect(() => {
    const article = scroll.current?.querySelector('article');
    if (!article) return;
    const observer = new ResizeObserver(() => restorePosition());
    observer.observe(article);
    return () => observer.disconnect();
  }, [note?.id, restorePosition]);
  useLayoutEffect(() => {
    // Toggling the sidebar reflows the article; keep the same point in the chapter.
    const position = tocPosition.current;
    tocPosition.current = null;
    if (!position || !scroll.current) return;
    const area = scroll.current;
    restoreTextPosition(area, position);
    const top = area.scrollTop;
    let active = true;
    // A newly selected font may finish loading after the initial reflow.
    void document.fonts.ready.then(() => {
      if (active && Math.abs(area.scrollTop - top) < 2) restoreTextPosition(area, position);
    });
    return () => {
      active = false;
    };
  }, [toc.sideOpen, readingPreferences]);
  const recordScroll = () => {
    const area = scroll.current;
    if (!note || !area || editing || (!restored.current && !touched.current)) return;
    let heading = '',
      headingRatio = 0;
    const top = area.getBoundingClientRect().top;
    const anchors = Array.from(
      area.querySelectorAll<HTMLElement>(
        '.read-content [id^="heading-"], .read-content [data-paper-heading]',
      ),
    );
    for (const [index, element] of anchors.entries()) {
      const anchorTop = element.getBoundingClientRect().top;
      if (anchorTop > top + 25) break;
      heading = element.id;
      const nextTop =
        anchors[index + 1]?.getBoundingClientRect().top ??
        area.querySelector('.read-content')!.getBoundingClientRect().bottom;
      headingRatio = Math.max(
        0,
        Math.min(1, (top + 24 - anchorTop) / Math.max(1, nextTop - anchorTop)),
      );
    }
    toc.setActive(heading);
    if (!touched.current || (!TEXT_KINDS.includes(note.kind) && !note.arxiv_id)) return;
    const ratio = Math.max(
      0,
      Math.min(1, area.scrollTop / Math.max(1, area.scrollHeight - area.clientHeight)),
    );
    const position = { ratio, ...(heading ? { heading, headingRatio } : {}) };
    reading.update(position);
    return position;
  };
  useEffect(() => {
    const remember = () => {
      if (editing || !scroll.current) return;
      touched.current = restored.current = true;
      tocPosition.current = recordScroll() ?? reading.initial;
    };
    window.addEventListener('note:before-reading-change', remember);
    return () => window.removeEventListener('note:before-reading-change', remember);
  });
  return {
    scroll, reading, toc, touched, restored, tocPosition, revealAppend, restorePosition, recordScroll,
  };
}
